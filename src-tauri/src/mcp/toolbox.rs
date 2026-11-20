//! MCP 工具箱：每个条目一条端口映射（云端 127.0.0.1:云端端口 → 本机目标），由 SSH 反向转发建立。
//! HTTP 服务（本机或局域网）直接转发到它的 host:port；
//! 本机命令（stdio）没有端口，由这里启动并桥接成内置服务下的 /mcp/<name>（只做请求/响应，服务端主动发的通知不转发）。

use anyhow::{Context, Result, anyhow, bail, ensure};
use axum::Json;
use axum::body::Bytes;
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStderr, ChildStdout};
use tokio::sync::oneshot;

use super::McpState;
use crate::settings::{BUILTIN_CLOUD_NAME, BUILTIN_NAME, KeyValue, Settings, Source, ToolboxItem};

/// 工具调用可能很长（浏览器操作、构建等）
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
/// 首次 npx/uvx 可能要先下载包
const START_TIMEOUT: Duration = Duration::from_secs(120);
const PROTOCOL_VERSION: &str = "2025-06-18";

type Slot = Arc<tokio::sync::Mutex<Option<Arc<StdioProc>>>>;

pub struct Toolbox {
    settings: Arc<RwLock<Settings>>,
    /// 每个本机命令一个槽；槽各自加锁，某个服务启动慢不会卡住别的
    slots: Mutex<HashMap<String, Slot>>,
    http: reqwest::Client,
}

#[derive(Serialize)]
pub struct TestResult {
    pub server: String,
    pub tools: Vec<ToolBrief>,
}

#[derive(Serialize)]
pub struct ToolBrief {
    pub name: String,
    pub description: String,
}

impl Toolbox {
    pub fn new(settings: Arc<RwLock<Settings>>) -> Self {
        // 局域网/本机服务不走系统代理；SSE 是长连接，不设整体超时
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("创建 HTTP 客户端");
        Self { settings, slots: Default::default(), http }
    }

    /// 已启用的条目；停用或不存在的一律拒绝
    pub fn enabled(&self, name: &str) -> Option<ToolboxItem> {
        self.settings.read().unwrap().toolbox.iter().find(|i| i.enabled && i.name == name).cloned()
    }

    /// 配置保存后调用：结束已删除、已停用或参数改过的进程，下次请求按新配置启动
    pub fn prune(&self) {
        let items = self.settings.read().unwrap().toolbox.clone();
        for slot in self.slots.lock().unwrap().values() {
            let Ok(mut slot) = slot.try_lock() else { continue };
            if slot.as_ref().is_some_and(|p| !items.iter().any(|i| i.enabled && *i == p.item)) {
                slot.take().unwrap().kill();
            }
        }
    }

    /// 应用退出时结束所有子进程（Windows 不会随父进程自动结束）
    pub fn shutdown(&self) {
        for slot in self.slots.lock().unwrap().values() {
            if let Some(p) = slot.try_lock().ok().and_then(|mut s| s.take()) {
                p.kill();
            }
        }
    }

    async fn proc(&self, item: &ToolboxItem) -> Result<Arc<StdioProc>> {
        let slot = self.slots.lock().unwrap().entry(item.name.clone()).or_default().clone();
        let mut slot = slot.lock().await;
        if let Some(p) = slot.as_ref().filter(|p| p.alive() && p.item == *item) {
            return Ok(p.clone());
        }
        if let Some(old) = slot.take() {
            old.kill();
        }
        let p = StdioProc::spawn(item.clone()).await?;
        *slot = Some(p.clone());
        Ok(p)
    }

    /// 用当前（可能未保存的）配置直接连一次服务，列出工具
    pub async fn test(&self, item: &ToolboxItem) -> Result<TestResult> {
        let run = async {
            match &item.source {
                Source::Stdio { .. } => {
                    let p = StdioProc::spawn(item.clone()).await?;
                    let list = p.request("tools/list", Some(json!({})), Duration::from_secs(60)).await;
                    p.kill();
                    summarize(p.init.get().unwrap_or(&Value::Null), &rpc_result(list?)?)
                }
                Source::Http { url, headers, legacy_sse: false } => self.test_http(url, headers).await,
                Source::Http { url, headers, legacy_sse: true } => self.test_sse(url, headers).await,
            }
        };
        tokio::time::timeout(START_TIMEOUT + Duration::from_secs(10), run)
            .await
            .map_err(|_| anyhow!("超过 {} 秒没有完成", START_TIMEOUT.as_secs() + 10))?
    }

    fn post(&self, url: &str, headers: &[KeyValue], msg: &Value, session: Option<&str>) -> reqwest::RequestBuilder {
        let mut req = self
            .http
            .post(url)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", PROTOCOL_VERSION)
            .body(msg.to_string());
        for kv in headers {
            req = req.header(&kv.key, &kv.value);
        }
        if let Some(s) = session {
            req = req.header("mcp-session-id", s);
        }
        req
    }

    async fn test_http(&self, url: &str, headers: &[KeyValue]) -> Result<TestResult> {
        let resp = ok_status(self.post(url, headers, &rpc(1, "initialize", init_params()), None).send().await?).await?;
        let session = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_string);
        let init = rpc_result(read_rpc(resp, 1).await?)?;
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        self.post(url, headers, &initialized, session.as_deref()).send().await?;
        let resp = self.post(url, headers, &rpc(2, "tools/list", json!({})), session.as_deref()).send().await?;
        let list = rpc_result(read_rpc(ok_status(resp).await?, 2).await?)?;
        if let Some(s) = &session {
            let _ = self.http.delete(url).header("mcp-session-id", s).send().await;
        }
        summarize(&init, &list)
    }

    async fn test_sse(&self, url: &str, headers: &[KeyValue]) -> Result<TestResult> {
        let mut req = self.http.get(url).header(header::ACCEPT, "text/event-stream");
        for kv in headers {
            req = req.header(&kv.key, &kv.value);
        }
        let mut events = SseReader::new(ok_status(req.send().await?).await?);
        let endpoint = loop {
            match events.next().await? {
                Some((event, data)) if event == "endpoint" => break data,
                Some(_) => continue,
                None => bail!("SSE 流没有给出 endpoint 事件，可能不是旧版 SSE 协议"),
            }
        };
        let endpoint = reqwest::Url::parse(url)?.join(&endpoint)?.to_string();
        ok_status(self.post(&endpoint, headers, &rpc(1, "initialize", init_params()), None).send().await?).await?;
        let init = rpc_result(events.wait_rpc(1).await?)?;
        let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        self.post(&endpoint, headers, &initialized, None).send().await?;
        ok_status(self.post(&endpoint, headers, &rpc(2, "tools/list", json!({})), None).send().await?).await?;
        let list = rpc_result(events.wait_rpc(2).await?)?;
        summarize(&init, &list)
    }
}

/// HTTP 条目在本机一侧的转发目标 host:port
pub fn http_target(url: &str) -> Result<(String, u16)> {
    let u = reqwest::Url::parse(url).with_context(|| format!("地址无效：{url}"))?;
    let host = u.host_str().context("地址里没有主机")?.trim_matches(['[', ']']).to_string();
    Ok((host, u.port_or_known_default().context("地址里没有端口")?))
}

/// 云端 Claude Code 用的地址：把本机地址的 host:port 换成云端 127.0.0.1:云端端口，路径不变
pub fn cloud_url(item: &ToolboxItem, remote_port: u16) -> Result<String> {
    match &item.source {
        Source::Stdio { .. } => Ok(format!("http://127.0.0.1:{remote_port}/mcp/{}", item.name)),
        Source::Http { url, .. } => {
            let mut u = reqwest::Url::parse(url)?;
            u.set_host(Some("127.0.0.1"))?;
            u.set_port(Some(remote_port)).map_err(|_| anyhow!("无法设置端口"))?;
            Ok(u.to_string())
        }
    }
}

/// 校验工具箱配置：名字要拼进云端命令和 URL 路径，只允许安全字符；云端端口不能重复
pub fn validate(items: &[ToolboxItem], builtin_port: u16) -> Result<()> {
    for (i, item) in items.iter().enumerate() {
        let n = &item.name;
        let p = item.remote_port;
        ensure!(p >= 1024, "「{n}」的云端端口要在 1024–65535 之间");
        ensure!(p != builtin_port, "「{n}」的云端端口 {p} 已被内置工具占用");
        ensure!(!items[..i].iter().any(|o| o.remote_port == p), "云端端口 {p} 重复");
        ensure!(
            !n.is_empty() && n.len() <= 32 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "名字「{n}」无效：只能用英文字母、数字、- 和 _，最多 32 个字符"
        );
        ensure!(n != BUILTIN_NAME && n != BUILTIN_CLOUD_NAME, "名字「{n}」已被内置工具占用");
        ensure!(!items[..i].iter().any(|o| o.name == *n), "名字「{n}」重复");
        match &item.source {
            Source::Stdio { command, .. } => ensure!(!command.trim().is_empty(), "「{n}」没有填启动命令"),
            Source::Http { url, .. } => {
                ensure!(url.starts_with("http://") || url.starts_with("https://"), "「{n}」的地址要以 http:// 或 https:// 开头");
                http_target(url).with_context(|| format!("「{n}」"))?;
            }
        }
    }
    Ok(())
}

/// 本机命令：把云端发来的 JSON-RPC 转给进程，换回原始 id 后返回
pub async fn stdio(st: &McpState, item: &ToolboxItem, method: Method, body: Bytes) -> Response {
    match method {
        Method::POST => {}
        // 桥接不分会话，结束会话无事可做
        Method::DELETE => return StatusCode::OK.into_response(),
        _ => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
    let Ok(req) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, "需要单条 JSON-RPC 消息").into_response();
    };
    let rpc_method = req["method"].as_str().unwrap_or("").to_string();
    let Some(id) = req.get("id").cloned() else {
        // 通知：initialized 在启动握手时已经发过，其余原样转给进程
        if rpc_method != "notifications/initialized" {
            if let Ok(p) = st.toolbox.proc(item).await {
                let _ = p.write(&req).await;
            }
        }
        return StatusCode::ACCEPTED.into_response();
    };
    let started = Instant::now();
    let outcome = async {
        let p = st.toolbox.proc(item).await?;
        // 进程在启动时已由网关握手，多个云端会话共用同一个进程，各自的 initialize 都回缓存的结果
        if rpc_method == "initialize" {
            return Ok(json!({ "result": p.init.get().cloned().unwrap_or_default() }));
        }
        p.request(&rpc_method, req.get("params").cloned(), CALL_TIMEOUT).await
    }
    .await;
    let mut resp = outcome
        .unwrap_or_else(|e| json!({ "error": { "code": -32000, "message": format!("{}：{e:#}", item.name) } }));
    resp["jsonrpc"] = json!("2.0");
    resp["id"] = id;
    if rpc_method == "tools/call" {
        audit_call(st, &item.name, &req, call_error(&resp), started);
    }
    Json(resp).into_response()
}

/// 工具失败的原因：JSON-RPC 错误或 isError 的第一段文字；成功返回 None
fn call_error(resp: &Value) -> Option<String> {
    if let Some(e) = resp.get("error") {
        return Some(e["message"].as_str().map(str::to_string).unwrap_or_else(|| e.to_string()));
    }
    (resp["result"]["isError"] == true)
        .then(|| resp["result"]["content"][0]["text"].as_str().unwrap_or("工具返回失败").to_string())
}

fn audit_call(st: &McpState, server: &str, req: &Value, error: Option<String>, started: Instant) {
    let params = &req["params"];
    let entry = json!({
        "ts": chrono::Local::now().to_rfc3339(),
        "server": server,
        "tool": format!("{server}/{}", params["name"].as_str().unwrap_or("")),
        "args": super::abbreviate(params.get("arguments").unwrap_or(&json!({}))),
        "ok": error.is_none(),
        "error": error,
        "ms": started.elapsed().as_millis() as u64,
    });
    super::record(st, &entry);
}

/// 一个本机 stdio MCP 进程。云端各会话的请求 id 会撞，转发时换成这里自增的 id
struct StdioProc {
    item: ToolboxItem,
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    /// 最近的 stderr，进程异常退出时告诉用户原因
    stderr: Mutex<VecDeque<String>>,
    /// initialize 的结果，云端每次 initialize 都回它
    init: OnceLock<Value>,
    pid: Option<u32>,
    child: Mutex<Child>,
}

impl StdioProc {
    async fn spawn(item: ToolboxItem) -> Result<Arc<Self>> {
        let Source::Stdio { command, args, env, cwd } = &item.source else {
            bail!("不是本机命令");
        };
        let mut cmd = tokio::process::Command::new(resolve_program(command.trim()));
        cmd.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for kv in env.iter().filter(|kv| !kv.key.is_empty()) {
            cmd.env(&kv.key, &kv.value);
        }
        if let Some(dir) = cwd.as_deref().filter(|d| !d.trim().is_empty()) {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(super::tasks::CREATE_NO_WINDOW);
        // 自成进程组：npx 会再起 node，结束时整组一起结束
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().with_context(|| format!("启动「{command}」失败"))?;
        let stdin = child.stdin.take().context("没有 stdin")?;
        let stdout = child.stdout.take().context("没有 stdout")?;
        let stderr = child.stderr.take().context("没有 stderr")?;
        let p = Arc::new(Self {
            item,
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Default::default(),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            stderr: Default::default(),
            init: OnceLock::new(),
            pid: child.id(),
            child: Mutex::new(child),
        });
        tokio::spawn(p.clone().read_stdout(stdout));
        tokio::spawn(p.clone().read_stderr(stderr));
        let handshake = async {
            let init = rpc_result(p.request("initialize", Some(init_params()), START_TIMEOUT).await?)?;
            let _ = p.init.set(init);
            p.write(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await
        };
        if let Err(e) = handshake.await {
            p.kill();
            return Err(e.context("握手失败"));
        }
        Ok(p)
    }

    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    async fn read_stdout(self: Arc<Self>, out: ChildStdout) {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // 有的服务会往 stdout 打日志，不是 JSON 的行跳过
            let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
            if msg.get("method").is_some() {
                // 服务端反向请求（roots/sampling 等）转不到云端，直接回不支持，免得它一直等；通知忽略
                if let Some(id) = msg.get("id") {
                    let reply = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "cc-remote-station 工具箱不支持此请求" } });
                    let _ = self.write(&reply).await;
                }
                continue;
            }
            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
                    let _ = tx.send(msg);
                }
            }
        }
        self.alive.store(false, Ordering::SeqCst);
        // 丢掉发送端，等待中的请求立即收到“进程已退出”
        self.pending.lock().unwrap().clear();
    }

    async fn read_stderr(self: Arc<Self>, err: ChildStderr) {
        // 中文 Windows 上的程序可能输出 GBK，按字节读再解码
        let mut reader = BufReader::new(err);
        let mut buf = Vec::new();
        while reader.read_until(b'\n', &mut buf).await.is_ok_and(|n| n > 0) {
            let line = super::tasks::decode_console(&buf).trim_end().to_string();
            buf.clear();
            let mut tail = self.stderr.lock().unwrap();
            tail.push_back(line);
            if tail.len() > 20 {
                tail.pop_front();
            }
        }
    }

    async fn write(&self, msg: &Value) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(format!("{msg}\n").as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    /// 发请求并等响应，返回完整的 JSON-RPC 响应消息
    async fn request(&self, method: &str, params: Option<Value>, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut msg = json!({ "jsonrpc": "2.0", "id": id, "method": method });
        if let Some(p) = params {
            msg["params"] = p;
        }
        if !self.alive() || self.write(&msg).await.is_err() {
            self.pending.lock().unwrap().remove(&id);
            bail!("{}", self.exited());
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => bail!("{}", self.exited()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                bail!("{} 秒内没有响应", timeout.as_secs())
            }
        }
    }

    fn exited(&self) -> String {
        let tail: Vec<String> = self.stderr.lock().unwrap().iter().cloned().collect();
        if tail.is_empty() {
            "进程已退出".into()
        } else {
            format!("进程已退出，最后的错误输出：\n{}", tail.join("\n"))
        }
    }

    /// npx 会先起 cmd.exe（Windows）或 shell 再起 node，要按进程树/进程组结束
    fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Some(pid) = self.pid {
            super::tasks::kill_tree(pid);
        }
        let _ = self.child.lock().unwrap().start_kill();
    }
}

/// Windows 创建进程不会按 PATHEXT 找 npx.cmd 这类脚本，自己在 PATH 里找一遍；
/// Rust 标准库能直接启动 .cmd/.bat 并正确转义参数
fn resolve_program(command: &str) -> PathBuf {
    let given = PathBuf::from(command);
    if !cfg!(windows) || given.components().count() > 1 || given.extension().is_some() {
        return given;
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    for dir in dirs {
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            let candidate = dir.join(format!("{command}{}", ext.to_lowercase()));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    given
}

fn init_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "cc-remote-station", "version": env!("CARGO_PKG_VERSION") },
    })
}

fn rpc(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn rpc_result(msg: Value) -> Result<Value> {
    if let Some(e) = msg.get("error") {
        bail!("服务返回错误：{}", e["message"].as_str().map(str::to_string).unwrap_or_else(|| e.to_string()));
    }
    Ok(msg["result"].clone())
}

fn summarize(init: &Value, list: &Value) -> Result<TestResult> {
    let info = &init["serverInfo"];
    let server = format!("{} {}", info["name"].as_str().unwrap_or(""), info["version"].as_str().unwrap_or("")).trim().to_string();
    let tools = list["tools"]
        .as_array()
        .context("tools/list 的结果里没有 tools")?
        .iter()
        .map(|t| ToolBrief {
            name: t["name"].as_str().unwrap_or("").to_string(),
            description: t["description"].as_str().unwrap_or("").to_string(),
        })
        .collect();
    Ok(TestResult { server, tools })
}

async fn ok_status(resp: reqwest::Response) -> Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let text = resp.text().await.unwrap_or_default();
    bail!("HTTP {status}：{}", text.chars().take(300).collect::<String>())
}

/// Streamable HTTP 的响应可能是 JSON，也可能是 SSE 流（结果在某个 message 事件里）
async fn read_rpc(resp: reqwest::Response, id: u64) -> Result<Value> {
    let is_stream = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    if is_stream {
        return SseReader::new(resp).wait_rpc(id).await;
    }
    Ok(serde_json::from_slice(&resp.bytes().await?).context("响应不是 JSON")?)
}

struct SseReader {
    resp: reqwest::Response,
    buf: Vec<u8>,
}

impl SseReader {
    fn new(resp: reqwest::Response) -> Self {
        Self { resp, buf: vec![] }
    }

    /// 下一个事件 (event, data)；流结束返回 None
    async fn next(&mut self) -> Result<Option<(String, String)>> {
        loop {
            if let Some(pos) = self.buf.windows(2).position(|w| w == b"\n\n") {
                let block: Vec<u8> = self.buf.drain(..pos + 2).collect();
                let block = String::from_utf8_lossy(&block);
                let (mut event, mut data) = (String::new(), Vec::new());
                for line in block.lines() {
                    if let Some(v) = line.strip_prefix("event:") {
                        event = v.trim().to_string();
                    } else if let Some(v) = line.strip_prefix("data:") {
                        data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
                    }
                }
                if event.is_empty() && data.is_empty() {
                    continue;
                }
                return Ok(Some((event, data.join("\n"))));
            }
            match self.resp.chunk().await? {
                Some(chunk) => self.buf.extend(chunk.iter().filter(|&&b| b != b'\r')),
                None => return Ok(None),
            }
        }
    }

    async fn wait_rpc(&mut self, id: u64) -> Result<Value> {
        while let Some((_, data)) = self.next().await? {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if v["id"] == id && v.get("method").is_none() {
                    return Ok(v);
                }
            }
        }
        bail!("连接已关闭，没有收到响应")
    }
}
