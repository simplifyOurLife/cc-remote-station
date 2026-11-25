mod chat;
mod hosts;
mod mcp;
mod settings;
mod ssh;
mod terminal;
mod update;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use hosts::{Host, HostStore, HostTool};
use settings::{BUILTIN_NAME, Settings, Source, ToolboxItem};
use ssh::{Conn, Credentials, Forward, NeedSecret, TrustedKey, UnknownHostKey};
use terminal::{Input, TermHandle};

pub struct AppState {
    hosts: HostStore,
    known_hosts: PathBuf,
    settings: Arc<RwLock<Settings>>,
    settings_path: PathBuf,
    /// 前端界面偏好（终端外观、快捷命令等），原样存取的 JSON
    ui_prefs_path: PathBuf,
    /// 历史会话缓存的默认目录（设置里没指定时用）
    cache_default: PathBuf,
    /// 内置 MCP 服务在本机监听的端口
    mcp_port: u16,
    /// MCP 的白名单/审计/备份，界面用它查看记录和恢复备份
    guard: Arc<mcp::Guard>,
    /// MCP 工具箱：管理本机 stdio 子进程、测试连接
    toolbox: Arc<mcp::Toolbox>,
    /// 按主机复用连接：同一台主机的多个终端和 MCP 转发走同一条 SSH 连接
    conns: tokio::sync::Mutex<HashMap<String, Arc<Conn>>>,
    /// 每台主机一把「正在建连接」的锁：同一台不重复连，不同主机互不阻塞
    connecting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 登录中途的验证码等输入：弹窗问用户
    prompter: ssh::Prompter,
    /// 云端执行本机命令前的弹窗确认
    approvals: Arc<mcp::Approvals>,
    terminals: Mutex<HashMap<String, TermHandle>>,
    /// 图形对话进程（chat id → stdin 写入端）
    chats: Mutex<HashMap<String, chat::ChatHandle>>,
}

/// 前端靠 code 区分需要弹窗处理的情况（确认主机密钥、输入密码）和普通失败
#[derive(Debug, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
enum CmdError {
    HostKeyUnknown { host: String, port: u16, fingerprint: String },
    #[serde(rename_all = "camelCase")]
    NeedSecret { host_id: String, host_name: String, kind: String, wrong: bool },
    Failed { message: String },
}

impl<E: Into<anyhow::Error>> From<E> for CmdError {
    fn from(e: E) -> Self {
        let e = e.into();
        if let Some(k) = e.downcast_ref::<UnknownHostKey>() {
            return CmdError::HostKeyUnknown { host: k.host.clone(), port: k.port, fingerprint: k.fingerprint.clone() };
        }
        if let Some(n) = e.downcast_ref::<NeedSecret>() {
            return CmdError::NeedSecret {
                host_id: n.host_id.clone(),
                host_name: n.host_name.clone(),
                kind: n.kind.to_string(),
                wrong: n.wrong,
            };
        }
        CmdError::Failed { message: format!("{e:#}") }
    }
}

type CmdResult<T> = Result<T, CmdError>;

async fn alive_conn(state: &AppState, host_id: &str) -> Option<Arc<Conn>> {
    let conn = state.conns.lock().await.get(host_id).cloned()?;
    if conn.alive().await {
        return Some(conn);
    }
    // 已断：从表里去掉（探测期间可能已被别人换成新连接，只删同一条）
    let mut conns = state.conns.lock().await;
    if conns.get(host_id).is_some_and(|c| Arc::ptr_eq(c, &conn)) {
        conns.remove(host_id);
    }
    None
}

/// 取该主机已有的连接，没有（或已断）就新建；返回的 bool 表示是否新建。
/// 建连接（含等用户输验证码）只锁这一台主机：同主机的其他标签排队复用同一条连接，别的主机不受影响
async fn get_or_connect(
    state: &AppState,
    host_id: &str,
    trust: Option<&TrustedKey>,
    creds: &Credentials,
) -> anyhow::Result<(Arc<Conn>, bool)> {
    if let Some(c) = alive_conn(state, host_id).await {
        return Ok((c, false));
    }
    let gate = state.connecting.lock().unwrap().entry(host_id.to_string()).or_default().clone();
    let _connecting = gate.lock().await;
    // 排队期间可能已经有人连上了
    if let Some(c) = alive_conn(state, host_id).await {
        return Ok((c, false));
    }
    let host = state.hosts.get(host_id)?;
    let forwards = host_forwards(state, &host);
    let conn = Arc::new(ssh::connect(&state.hosts, &state.known_hosts, &host, trust, creds, &state.prompter, forwards).await?);
    state.conns.lock().await.insert(host_id.to_string(), conn.clone());
    Ok((conn, true))
}

/// 主机用的工具；从没配过时只有内置工具
fn host_tools(host: &Host) -> Vec<HostTool> {
    host.tools.clone().unwrap_or_else(|| vec![HostTool { name: BUILTIN_NAME.into(), remote_port: None }])
}

/// 主机上某个工具实际转发用的云端端口：主机里改过的优先，否则用工具箱里的默认映射端口；工具已不在工具箱里时为 None
fn host_tool_port(s: &Settings, t: &HostTool) -> Option<u16> {
    let port = if t.name == BUILTIN_NAME {
        s.remote_port
    } else {
        s.toolbox.iter().find(|i| i.name == t.name)?.remote_port
    };
    Some(t.remote_port.unwrap_or(port))
}

/// 保存主机前校验：这台主机上转发的云端端口不能重复
fn check_host_tools(s: &Settings, host: &Host) -> anyhow::Result<()> {
    let mut ports = Vec::new();
    for t in host_tools(host) {
        let Some(port) = host_tool_port(s, &t) else { continue };
        anyhow::ensure!(port >= 1024, "「{}」的云端端口要在 1024–65535 之间", t.name);
        anyhow::ensure!(!ports.contains(&port), "云端端口 {port} 重复了");
        ports.push(port);
    }
    Ok(())
}
/// 主机用的工具各自的端口映射：内置工具和本机命令接到内置服务，HTTP 条目接到它自己的 host:port。
/// 未开启工具箱的主机、已停用或已删除的条目不建转发
fn host_forwards(state: &AppState, host: &Host) -> Vec<Forward> {
    if !host.mcp {
        return vec![];
    }
    let s = state.settings.read().unwrap();
    let local = |name: &str, remote_port: u16| Forward {
        name: name.to_string(),
        remote_port,
        target_host: "127.0.0.1".into(),
        target_port: state.mcp_port,
    };
    let mut list = Vec::new();
    for t in host_tools(host) {
        let Some(port) = host_tool_port(&s, &t) else { continue };
        if t.name == BUILTIN_NAME {
            list.push(local(&t.name, port));
            continue;
        }
        let Some(item) = s.toolbox.iter().find(|i| i.enabled && i.name == t.name) else { continue };
        match &item.source {
            Source::Stdio { .. } => list.push(local(&t.name, port)),
            Source::Http { url, .. } => {
                if let Ok((target_host, target_port)) = mcp::http_target(url) {
                    list.push(Forward { name: t.name, remote_port: port, target_host, target_port });
                }
            }
        }
    }
    list
}
/// 会话名会拼进远端 shell 命令，只允许安全字符
fn check_session_name(name: &str) -> anyhow::Result<()> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(anyhow!("非法的 tmux 会话名: {name}"));
    }
    Ok(())
}

#[tauri::command]
fn hosts_list(state: State<AppState>) -> CmdResult<Vec<Host>> {
    Ok(state.hosts.list()?)
}

/// secret：None 不改；空串删除；否则写入系统凭据管理器（密码或私钥口令）。
/// 保存后从连接池移除该主机：新开的标签按新设置重连，已开的标签继续用旧连接直到关闭
#[tauri::command]
async fn host_save(state: State<'_, AppState>, host: Host, secret: Option<String>) -> CmdResult<Host> {
    if host.mcp {
        check_host_tools(&state.settings.read().unwrap(), &host)?;
    }
    let host = state.hosts.upsert(host)?;
    state.conns.lock().await.remove(&host.id);
    match secret.as_deref() {
        None => {}
        Some("") => hosts::secret_delete(&host.id)?,
        Some(s) => hosts::secret_set(&host.id, s)?,
    }
    Ok(host)
}

#[tauri::command]
async fn host_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.conns.lock().await.remove(&id);
    Ok(state.hosts.delete(&id)?)
}

#[derive(Serialize)]
struct OpenResult {
    id: String,
    /// 连接成功但有附带问题（如 MCP 转发失败），前端在终端里提示
    notice: Option<String>,
}

/// secrets：弹窗里刚输入的密码/口令（按主机 id）；remember 为 true 时认证成功后保存
#[tauri::command]
async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    cols: u32,
    rows: u32,
    trust: Option<TrustedKey>,
    secrets: Option<HashMap<String, String>>,
    remember: bool,
    session: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> CmdResult<OpenResult> {
    if let Some(name) = &session {
        check_session_name(name)?;
    }
    let creds = Credentials { secrets: secrets.unwrap_or_default(), remember };
    let (conn, fresh) = get_or_connect(&state, &host_id, trust.as_ref(), &creds).await?;
    // 只在新建连接时提示一次转发失败，复用连接的标签不重复提醒
    let failed: Vec<String> = conn.forwards.iter().filter_map(|f| f.error.as_ref().map(|e| format!("{}：{e}", f.name))).collect();
    let notice = (fresh && !failed.is_empty()).then(|| failed.join("\n"));
    let id = uuid::Uuid::new_v4().to_string();
    let dir = state.hosts.get(&host_id)?.dir;
    let tx = terminal::open(app, id.clone(), conn.clone(), cols, rows, session.as_deref(), dir.as_deref(), on_data).await?;
    state.terminals.lock().unwrap().insert(id.clone(), TermHandle { tx, conn, session });
    Ok(OpenResult { id, notice })
}

fn send(state: &AppState, id: &str, input: Input) {
    if let Some(t) = state.terminals.lock().unwrap().get(id) {
        let _ = t.tx.send(input);
    }
}

#[tauri::command]
fn terminal_write(state: State<AppState>, id: String, data: Vec<u8>) {
    send(&state, &id, Input::Data(data));
}

#[tauri::command]
fn terminal_resize(state: State<AppState>, id: String, cols: u32, rows: u32) {
    send(&state, &id, Input::Resize(cols, rows));
}

/// kill_session：用户主动关标签时为 true，顺带结束远端 tmux 会话，避免会话堆积
#[tauri::command]
fn terminal_close(state: State<AppState>, id: String, kill_session: bool) {
    let Some(TermHandle { tx, conn, session }) = state.terminals.lock().unwrap().remove(&id) else {
        return;
    };
    let _ = tx.send(Input::Close);
    if let (true, Some(name)) = (kill_session, session) {
        tauri::async_runtime::spawn(async move {
            let _ = conn.exec(&format!("tmux kill-session -t {name}"), None).await;
        });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TmuxSession {
    name: String,
    /// 是否有客户端正连着（可能是另一个标签或别的电脑）
    attached: bool,
    /// 最后活动时间，Unix 秒
    activity: u64,
}

/// 列出该主机上 cc-remote-station 建的 tmux 会话（ccws- 前缀），用于接回或清理
#[tauri::command]
async fn tmux_sessions(state: State<'_, AppState>, host_id: String) -> CmdResult<Vec<TmuxSession>> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let out = conn
        .exec("tmux ls -F '#{session_name}|#{session_attached}|#{session_activity}' 2>/dev/null", None)
        .await?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut sessions = Vec::new();
    for line in text.lines().filter(|l| l.starts_with("ccws-")) {
        let mut parts = line.split('|');
        let (Some(name), Some(attached), Some(activity)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        sessions.push(TmuxSession {
            name: name.to_string(),
            attached: attached != "0",
            activity: activity.parse().unwrap_or(0),
        });
    }
    sessions.sort_by(|a, b| b.activity.cmp(&a.activity));
    Ok(sessions)
}

#[tauri::command]
async fn tmux_kill(state: State<'_, AppState>, host_id: String, name: String) -> CmdResult<()> {
    check_session_name(&name)?;
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    conn.exec(&format!("tmux kill-session -t {name}"), None).await?;
    Ok(())
}

/// 系统通知走 Rust 侧：JS 端的 Notification 会先查权限状态，启动初期未就绪时会静默丢弃
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> CmdResult<()> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show()?;
    Ok(())
}

/// 剪贴板里有图片就传到该终端所在主机，返回远端路径；没有图片返回 None
#[tauri::command]
async fn terminal_paste_image(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<Option<String>> {
    let Ok(image) = app.clipboard().read_image() else {
        return Ok(None);
    };
    let png = terminal::encode_png(image.rgba(), image.width(), image.height())?;
    let conn = state.terminals.lock().unwrap().get(&id).map(|t| t.conn.clone()).context("终端已关闭")?;
    Ok(Some(terminal::upload_clipboard_image(&conn, &png).await?))
}

#[tauri::command]
fn settings_get(state: State<AppState>) -> Settings {
    state.settings.read().unwrap().clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPatch {
    roots: Vec<String>,
    command_mode: settings::CommandMode,
    command_allowlist: Vec<String>,
    remote_port: u16,
    device: String,
    builtin_alias: String,
}

#[tauri::command]
fn settings_save(state: State<AppState>, patch: SettingsPatch) -> CmdResult<Settings> {
    let mut s = state.settings.write().unwrap();
    if let Some(item) = s.toolbox.iter().find(|i| i.remote_port == patch.remote_port) {
        return Err(anyhow!("云端端口 {} 已被工具箱里的「{}」占用", patch.remote_port, item.name).into());
    }
    // 标识会拼进云端命令和 MCP 名字
    let device = patch.device.trim().to_string();
    let valid = device.len() <= 16 && device.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(anyhow!("电脑标识只能用英文字母、数字、- 和 _，最多 16 个字符").into());
    }
    let mut next = s.clone();
    next.roots = patch.roots;
    next.command_mode = patch.command_mode;
    let mut allowlist: Vec<String> = Vec::new();
    for rule in patch.command_allowlist {
        let rule = rule.split_whitespace().collect::<Vec<_>>().join(" ");
        if !rule.is_empty() && !allowlist.contains(&rule) {
            allowlist.push(rule);
        }
    }
    next.command_allowlist = allowlist;
    next.remote_port = patch.remote_port;
    next.device = device;
    next.builtin_alias = patch.builtin_alias.trim().to_string();
    next.check_cloud_names()?;
    next.save(&state.settings_path)?;
    *s = next;
    Ok(s.clone())
}

/// 回答命令确认弹窗：decision 为 once / always / deny，always 时 rule 是要加进白名单的规则
#[tauri::command]
fn command_confirm_answer(state: State<AppState>, id: String, decision: String, rule: Option<String>) {
    let d = match (decision.as_str(), rule) {
        ("once", _) => mcp::Decision::Once,
        ("always", Some(r)) if !r.trim().is_empty() => mcp::Decision::Always(r),
        _ => mcp::Decision::Deny,
    };
    state.approvals.answer(&id, d);
}

/// 换新令牌后，已配置的云端 Claude Code 需要重新「一键配置」
#[tauri::command]
fn settings_regen_token(state: State<AppState>) -> CmdResult<Settings> {
    let mut s = state.settings.write().unwrap();
    s.token = settings::new_token();
    s.save(&state.settings_path)?;
    Ok(s.clone())
}

/// 保存工具箱列表；删掉、停用或改了参数的本机命令会被结束，下次请求按新配置启动
#[tauri::command]
fn toolbox_save(state: State<AppState>, items: Vec<ToolboxItem>) -> CmdResult<Vec<ToolboxItem>> {
    {
        let mut s = state.settings.write().unwrap();
        mcp::validate_toolbox(&items, s.remote_port)?;
        let mut next = s.clone();
        next.toolbox = items.into_iter().map(|i| ToolboxItem { alias: i.alias.trim().to_string(), ..i }).collect();
        next.check_cloud_names()?;
        next.save(&state.settings_path)?;
        *s = next;
    }
    state.toolbox.prune();
    Ok(state.settings.read().unwrap().toolbox.clone())
}

/// 用当前配置试连一次（不必先保存），返回服务名和工具列表
#[tauri::command]
async fn toolbox_test(state: State<'_, AppState>, item: ToolboxItem) -> CmdResult<mcp::TestResult> {
    Ok(state.toolbox.test(&item).await?)
}

/// 扫本机 Claude Code / Claude Desktop / Cursor 里已配的 MCP，供工具箱导入
#[tauri::command]
fn toolbox_import_scan() -> Vec<mcp::ImportCandidate> {
    mcp::scan_imports()
}

/// 内置工具列表（name / description / inputSchema）
#[tauri::command]
fn toolbox_builtin() -> Value {
    mcp::builtin_tools()
}

/// 内置服务在本机监听的端口（内置工具和本机命令类工具的转发目标）
#[tauri::command]
fn mcp_local_port(state: State<AppState>) -> u16 {
    state.mcp_port
}

#[tauri::command]
fn ui_prefs_get(state: State<AppState>) -> CmdResult<Value> {
    match std::fs::read_to_string(&state.ui_prefs_path) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(_) => Ok(Value::Object(Default::default())),
    }
}

#[tauri::command]
fn ui_prefs_set(state: State<AppState>, prefs: Value) -> CmdResult<()> {
    std::fs::write(&state.ui_prefs_path, serde_json::to_string_pretty(&prefs)?)?;
    Ok(())
}

#[tauri::command]
fn audit_days(state: State<AppState>) -> Vec<String> {
    state.guard.audit_days()
}

#[tauri::command]
fn audit_entries(state: State<AppState>, day: String) -> Vec<Value> {
    state.guard.audit_entries(&day)
}

#[tauri::command]
fn backups_list(state: State<AppState>) -> Vec<mcp::BackupEntry> {
    state.guard.list_backups(500)
}

/// 把备份恢复到原位置，返回恢复到的路径
#[tauri::command]
fn backup_restore(state: State<AppState>, id: String) -> CmdResult<String> {
    Ok(state.guard.restore(&id)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpHostStatus {
    host_id: String,
    /// 这台主机上每条工具箱端口映射的建立结果
    forwards: Vec<ssh::ForwardState>,
}

/// 当前在线连接上的工具箱反向转发状态；未连接或没有转发的主机不列出
#[tauri::command]
async fn mcp_status(state: State<'_, AppState>) -> CmdResult<Vec<McpHostStatus>> {
    let conns = state.conns.lock().await;
    Ok(conns
        .iter()
        .filter(|(_, c)| !c.handle.is_closed() && !c.forwards.is_empty())
        .map(|(id, c)| McpHostStatus { host_id: id.clone(), forwards: c.forwards.clone() })
        .collect())
}

/// 读取 ~/.ssh/config 原文（不存在返回空串），由前端解析后让用户勾选导入
#[tauri::command]
fn ssh_config_read() -> String {
    dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".ssh").join("config")).ok())
        .unwrap_or_default()
}

/// 一个工具在云端 claude mcp add 用的参数
struct McpSpec {
    transport: &'static str,
    url: String,
    headers: Vec<String>,
}

/// 按连接上实际建立的转发算出每个工具应配的地址（端口以连接时为准）；转发失败的给出原因
fn mcp_specs(state: &AppState, conn: &Conn) -> Vec<(String, Result<McpSpec, String>)> {
    let (token, items) = {
        let s = state.settings.read().unwrap();
        (s.token.clone(), s.toolbox.clone())
    };
    let auth = format!("Authorization: Bearer {token}");
    let spec = |name: &str, remote_port: u16| -> Result<McpSpec, String> {
        if name == BUILTIN_NAME {
            return Ok(McpSpec { transport: "http", url: format!("http://127.0.0.1:{remote_port}/mcp"), headers: vec![auth.clone()] });
        }
        let item = items.iter().find(|i| i.name == name).ok_or("工具箱里已没有这个工具")?;
        let url = mcp::cloud_url(item, remote_port).map_err(|e| format!("{e:#}"))?;
        Ok(match &item.source {
            Source::Stdio { .. } => McpSpec { transport: "http", url, headers: vec![auth.clone()] },
            Source::Http { headers, legacy_sse, .. } => McpSpec {
                transport: if *legacy_sse { "sse" } else { "http" },
                url,
                headers: headers.iter().map(|kv| format!("{}: {}", kv.key, kv.value)).collect(),
            },
        })
    };
    conn.forwards
        .iter()
        .map(|f| (f.name.clone(), f.error.clone().map_or_else(|| spec(&f.name, f.remote_port), Err)))
        .collect()
}

/// 在云主机上跑一段脚本。不用交互 shell：.bashrc 里的自动 tmux / 提示等在无终端时会卡住
async fn run_remote(conn: &Arc<Conn>, script: &str) -> anyhow::Result<String> {
    let cmd = format!("bash -lc {} </dev/null", chat::shell_quote(script));
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), conn.exec(&cmd, None))
        .await
        .context("云端命令 30 秒未返回，可能是登录脚本（~/.bash_profile 等）在等待输入")??;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.code != 0 {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("退出码 {}：{stdout}\n{}", out.code, stderr.trim());
    }
    Ok(stdout)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WantedMcp {
    name: String,
    /// 工具箱里的默认映射名称（设了电脑标识时带后缀），注册时可以改；是否已注册按 url 匹配
    default_name: String,
    /// 应配的地址；转发没建立时为 None，原因在 error
    url: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeMcpState {
    /// 解析成绝对路径的项目目录；全局时为 None
    dir: Option<String>,
    /// ~/.claude.json 里记录过的项目目录，供选择
    projects: Vec<String>,
    /// 全局（user 作用域）已配置的 MCP：名字 → 地址（stdio 类为命令行）
    global: HashMap<String, String>,
    /// 所选项目（local 作用域）已配置的 MCP
    project: HashMap<String, String>,
    /// 这台主机勾选的工具应配的地址
    wanted: Vec<WantedMcp>,
}

fn server_map(v: &Value) -> HashMap<String, String> {
    let Some(map) = v.as_object() else { return HashMap::new() };
    map.iter()
        .map(|(name, s)| {
            let addr = s["url"].as_str().map(str::to_string).unwrap_or_else(|| {
                let args: Vec<&str> = s["args"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                format!("{} {}", s["command"].as_str().unwrap_or(""), args.join(" ")).trim().to_string()
            });
            (name.clone(), addr)
        })
        .collect()
}

/// 读云端 Claude Code 当前的 MCP 配置（~/.claude.json），和这台主机应配的对比用。
/// 没有连接时自动连上（顺便建立端口映射）；dir 为空表示只看全局
#[tauri::command]
async fn claude_mcp_state(state: State<'_, AppState>, host_id: String, dir: Option<String>) -> CmdResult<ClaudeMcpState> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let dir = match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => Some(
            run_remote(&conn, &format!("cd {} && pwd -P", chat::cd_target(d)))
                .await
                .with_context(|| format!("云主机上找不到目录 {d}"))?,
        ),
        None => None,
    };
    let raw = conn.exec("cat ~/.claude.json 2>/dev/null", None).await?;
    let config: Value = serde_json::from_slice(&raw.stdout).unwrap_or_default();
    let mut projects: Vec<String> = config["projects"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    projects.sort();
    let project = dir.as_ref().map(|d| server_map(&config["projects"][d]["mcpServers"])).unwrap_or_default();
    let settings = state.settings.read().unwrap().clone();
    let wanted = mcp_specs(&state, &conn)
        .into_iter()
        .map(|(name, spec)| {
            let default_name = settings.cloud_name(&name);
            match spec {
                Ok(s) => WantedMcp { name, default_name, url: Some(s.url), error: None },
                Err(e) => WantedMcp { name, default_name, url: None, error: Some(e) },
            }
        })
        .collect();
    Ok(ClaudeMcpState { dir, projects, global: server_map(&config["mcpServers"]), project, wanted })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpRegister {
    /// 工具箱里的名字
    name: String,
    /// 在 Claude 里的名字
    cloud_name: String,
}

/// 在云端注册（先删后加）或移除 MCP。dir 为空写全局（user），否则写该项目（local，仅在该目录下生效）。
/// remove 是 Claude 里已有的名字；只动传进来的名字，用户在云端自己加的其他 MCP 不碰
#[tauri::command]
async fn claude_mcp_apply(
    state: State<'_, AppState>,
    host_id: String,
    dir: Option<String>,
    add: Vec<McpRegister>,
    remove: Vec<String>,
) -> CmdResult<String> {
    if let Some(a) = add.iter().find(|a| {
        let n = &a.cloud_name;
        n.is_empty() || n.len() > 48 || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }) {
        return Err(anyhow!("名字「{}」无效：只能用英文字母、数字、- 和 _", a.cloud_name).into());
    }
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let scope = if dir.is_some() { "local" } else { "user" };
    let specs = mcp_specs(&state, &conn);
    // 移除的名字来自云端已有配置，可能带任意字符，一律加引号
    let mut steps: Vec<String> = add
        .iter()
        .map(|a| &a.cloud_name)
        .chain(&remove)
        .map(|n| format!("claude mcp remove {} -s {scope} >/dev/null 2>&1", chat::shell_quote(n)))
        .collect();
    let mut adds = Vec::new();
    for a in &add {
        let name = &a.name;
        let spec = match specs.iter().find(|(n, _)| n == name) {
            Some((_, Ok(s))) => s,
            Some((_, Err(e))) => return Err(anyhow!("「{name}」的端口转发没有建立：{e}").into()),
            None => return Err(anyhow!("这台主机没有转发「{name}」").into()),
        };
        let headers: String = spec.headers.iter().map(|h| format!(" --header {}", chat::shell_quote(h))).collect();
        adds.push(format!(
            "claude mcp add --transport {} -s {scope} {} {}{headers}",
            spec.transport,
            a.cloud_name,
            chat::shell_quote(&spec.url)
        ));
    }
    if !adds.is_empty() {
        steps.push(adds.join(" && "));
    }
    let cd = dir.as_deref().map(|d| format!("cd {} && ", chat::cd_target(d))).unwrap_or_default();
    let script = format!("{}{cd}{{ {}; }}", chat::CLAUDE_PATH_SETUP, steps.join("; "));
    Ok(run_remote(&conn, &script).await.context("云端执行 claude mcp 失败")?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeConfig {
    /// `/config` 不带参数的用法说明：每行 key=可选值
    usage: String,
    /// ~/.claude/settings.json、<dir>/.claude/settings.json、<dir>/.claude/settings.local.json
    user: Value,
    project: Value,
    local: Value,
    /// ~/.claude.json 的顶层标量（部分 /config 项存在这里）
    global: Value,
}

const CONFIG_SEP: &str = "@@ccws-config@@";

/// 图形版 /config 的数据。-p 模式没有读配置的控制请求，这里用一次性的
/// `claude -p --no-session-persistence "/config"`（不留会话记录）取可设的键，再直接读几份配置文件拿当前值
#[tauri::command]
async fn claude_config_read(state: State<'_, AppState>, host_id: String, dir: String) -> CmdResult<ClaudeConfig> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let script = format!(
        "{}cd {} || exit 1; claude -p --no-session-persistence '/config'; \
         for f in ~/.claude/settings.json .claude/settings.json .claude/settings.local.json ~/.claude.json; do \
           echo {CONFIG_SEP}; cat \"$f\" 2>/dev/null; done",
        chat::CLAUDE_PATH_SETUP,
        chat::cd_target(&dir)
    );
    let out = run_remote(&conn, &script).await.context("云端读取 Claude Code 配置失败")?;
    let mut parts = out.split(CONFIG_SEP).map(str::trim);
    let usage = parts.next().unwrap_or_default().to_string();
    let mut json = || serde_json::from_str::<Value>(parts.next().unwrap_or_default()).unwrap_or(Value::Null);
    let (user, project, local) = (json(), json(), json());
    // ~/.claude.json 里有项目历史等大对象，只留标量
    let global = match json() {
        Value::Object(m) => Value::Object(m.into_iter().filter(|(_, v)| !v.is_object() && !v.is_array()).collect()),
        _ => Value::Null,
    };
    Ok(ClaudeConfig { usage, user, project, local, global })
}

/// 执行 `/config key=value`，返回 CLI 的说明（成功是 "Set …"，值不对也是退出码 0 加一句说明）
#[tauri::command]
async fn claude_config_set(state: State<'_, AppState>, host_id: String, dir: String, key: String, value: String) -> CmdResult<String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(anyhow!("配置项名无效：{key}").into());
    }
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let script = format!(
        "{}cd {} || exit 1; claude -p --no-session-persistence {}",
        chat::CLAUDE_PATH_SETUP,
        chat::cd_target(&dir),
        chat::shell_quote(&format!("/config {key}={value}"))
    );
    Ok(run_remote(&conn, &script).await.context("云端执行 /config 失败")?)
}

/// 额度估算的埋点：追加到远端 ~/.cache/cc-workstation/quota.jsonl（一行一条 JSON），超过 1MB 只留后一半。
/// 放在云主机上，云端 Claude 排查估算问题时可以直接读
#[tauri::command]
async fn quota_log(state: State<'_, AppState>, host_id: String, lines: String) -> CmdResult<()> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let cmd = "f=\"$HOME/.cache/cc-workstation/quota.jsonl\"; mkdir -p \"${f%/*}\" && cat >> \"$f\" && \
               if [ \"$(wc -c < \"$f\")\" -gt 1048576 ]; then tail -c 524288 \"$f\" | tail -n +2 > \"$f.tmp\" && mv \"$f.tmp\" \"$f\"; fi";
    let out = conn.exec(cmd, Some(lines.as_bytes())).await?;
    if out.code != 0 {
        return Err(anyhow!("写额度埋点失败：{}", String::from_utf8_lossy(&out.stderr).trim()).into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostCheck {
    /// claude --version 的输出；没装为 None
    claude: Option<String>,
    /// 找到登录信息（OAuth 凭据、API Key 或 settings.json 里的 ANTHROPIC_* 环境变量）
    logged_in: bool,
    tmux: bool,
}

/// 上手清单的「检查云主机环境」：claude 是否安装、是否登录过、有没有 tmux。没连接会自动连上
#[tauri::command]
async fn host_check(state: State<'_, AppState>, host_id: String) -> CmdResult<HostCheck> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let script = format!(
        "{}echo \"claude=$(claude --version 2>/dev/null | head -n 1)\"; \
         if [ -n \"$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN\" ] || [ -s ~/.claude/.credentials.json ] \
            || grep -q '\"oauthAccount\"' ~/.claude.json 2>/dev/null || grep -q 'ANTHROPIC_' ~/.claude/settings.json 2>/dev/null; \
         then echo login=1; else echo login=0; fi; \
         command -v tmux >/dev/null 2>&1 && echo tmux=1 || echo tmux=0",
        chat::CLAUDE_PATH
    );
    let out = run_remote(&conn, &script).await?;
    let get = |k: &str| out.lines().find_map(|l| l.strip_prefix(k)).map(str::trim).unwrap_or("");
    let claude = get("claude=");
    Ok(HostCheck {
        claude: (!claude.is_empty()).then(|| claude.to_string()),
        logged_in: get("login=") == "1",
        tmux: get("tmux=") == "1",
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStartArgs {
    host_id: String,
    cwd: String,
    resume: Option<String>,
    #[serde(default)]
    fork: bool,
    model: Option<String>,
    permission_mode: String,
    #[serde(default)]
    prompt_suggestions: bool,
}

/// 启动云端 claude（stream-json），返回 chat id；事件逐行推到 on_event
#[tauri::command]
async fn chat_start(
    app: AppHandle,
    state: State<'_, AppState>,
    args: ChatStartArgs,
    on_event: Channel<Value>,
) -> CmdResult<String> {
    let (conn, _) = get_or_connect(&state, &args.host_id, None, &Credentials::default()).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let opts = chat::StartOptions {
        cwd: args.cwd,
        resume: args.resume,
        fork: args.fork,
        model: args.model,
        permission_mode: args.permission_mode,
        prompt_suggestions: args.prompt_suggestions,
    };
    let tx = chat::start(app, id.clone(), conn, opts, on_event).await?;
    state.chats.lock().unwrap().insert(id.clone(), chat::ChatHandle { tx });
    Ok(id)
}

/// 向对话进程写一行 JSON（用户消息、审批回复、中断等控制请求都由前端组好）
#[tauri::command]
fn chat_send(state: State<AppState>, id: String, message: Value) -> CmdResult<()> {
    Ok(chat::send(&state, &id, message.to_string())?)
}

#[tauri::command]
fn chat_stop(state: State<AppState>, id: String) {
    // 丢掉写入端即关闭 stdin，后台任务随之关闭通道
    state.chats.lock().unwrap().remove(&id);
}

/// dir 有值时只读这个工作目录的会话；为空时扫全部目录最近的会话
#[tauri::command]
async fn chat_sessions(state: State<'_, AppState>, host_id: String, dir: Option<String>) -> CmdResult<Vec<chat::SessionInfo>> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let dir = dir.as_deref().map(str::trim).filter(|d| !d.is_empty());
    Ok(chat::list_sessions(&conn, dir).await?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostTimezone {
    /// IANA 时区名（如 America/Los_Angeles），拿不到为 None
    iana: Option<String>,
    /// 当前 UTC 偏移（分钟），没有 IANA 名时用它
    offset_min: i32,
}

/// 云主机的时区：对话里的时间（额度重置、历史会话）按 Claude 运行的地方显示。
/// 登录 shell 里的 TZ 优先，其次系统时区
#[tauri::command]
async fn host_timezone(state: State<'_, AppState>, host_id: String) -> CmdResult<HostTimezone> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let out = run_remote(
        &conn,
        "tz=\"${TZ:-}\"; [ -z \"$tz\" ] && tz=$(timedatectl show -p Timezone --value 2>/dev/null); \
         [ -z \"$tz\" ] && [ -f /etc/timezone ] && tz=$(cat /etc/timezone); \
         [ -z \"$tz\" ] && tz=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||'); \
         echo \"$tz\"; date +%z",
    )
    .await?;
    let mut lines = out.lines().map(str::trim);
    let iana = lines.next().filter(|s| !s.is_empty() && !s.starts_with(':')).map(str::to_string);
    // date +%z 形如 +0800 / -0700
    let offset_min = lines
        .next()
        .filter(|z| z.len() == 5)
        .and_then(|z| {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let h: i32 = z[1..3].parse().ok()?;
            let m: i32 = z[3..5].parse().ok()?;
            Some(sign * (h * 60 + m))
        })
        .unwrap_or(0);
    Ok(HostTimezone { iana, offset_min })
}

/// 云端 Claude 最近用过的工作目录（新的在前），供对话页选择目录
#[tauri::command]
async fn chat_dirs(state: State<'_, AppState>, host_id: String) -> CmdResult<Vec<String>> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    Ok(chat::recent_dirs(&conn).await?)
}

impl AppState {
    fn cache_root(&self) -> PathBuf {
        self.settings.read().unwrap().chat_cache_dir.as_deref().map_or_else(|| self.cache_default.clone(), PathBuf::from)
    }
}

/// 读历史会话：有本机缓存就只增量拉新增部分，读完更新缓存
#[tauri::command]
async fn chat_history(state: State<'_, AppState>, host_id: String, file: String) -> CmdResult<Vec<Value>> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    let root = state.cache_root();
    let lines = chat::history(&conn, &file, Some(&chat::cache_path(&root, &host_id, &file))).await?;
    tauri::async_runtime::spawn_blocking(move || chat::cache_prune(&root));
    Ok(lines)
}

/// 只读本机缓存（不连云端）：打开会话时先显示，再用 chat_history 补上新增的部分；没缓存返回 None
#[tauri::command]
async fn chat_history_cached(state: State<'_, AppState>, host_id: String, file: String) -> CmdResult<Option<Vec<Value>>> {
    let path = chat::cache_path(&state.cache_root(), &host_id, &file);
    Ok(tauri::async_runtime::spawn_blocking(move || chat::cached_history(&path)).await.context("读取会话缓存失败")?)
}

#[tauri::command]
async fn chat_delete(state: State<'_, AppState>, host_id: String, file: String) -> CmdResult<()> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    chat::delete_session(&conn, &file).await?;
    let _ = std::fs::remove_file(chat::cache_path(&state.cache_root(), &host_id, &file));
    Ok(())
}

#[tauri::command]
fn chat_cache_info(state: State<AppState>) -> chat::CacheInfo {
    chat::cache_info(&state.cache_root(), &state.cache_default)
}

/// 换缓存目录（None 恢复默认）。原目录里的缓存留在原地，不搬也不删
#[tauri::command]
fn chat_cache_set_dir(state: State<AppState>, dir: Option<String>) -> CmdResult<chat::CacheInfo> {
    let dir = dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    if let Some(d) = &dir {
        let p = std::path::Path::new(d);
        if !p.is_absolute() {
            return Err(anyhow::anyhow!("请填写完整路径，如 D:\\cc-cache").into());
        }
        std::fs::create_dir_all(p).with_context(|| format!("无法创建目录 {d}"))?;
    }
    {
        let mut s = state.settings.write().unwrap();
        let mut next = s.clone();
        next.chat_cache_dir = dir;
        next.save(&state.settings_path)?;
        *s = next;
    }
    Ok(chat_cache_info(state))
}

#[tauri::command]
fn chat_cache_clear(state: State<AppState>) -> chat::CacheInfo {
    chat::cache_clear(&state.cache_root());
    chat_cache_info(state)
}

/// 把用户在「打开」对话框里选的本机文件传到云主机，返回远端路径（对话附件用，Claude 用 Read 读取）
#[tauri::command]
async fn chat_upload(state: State<'_, AppState>, host_id: String, path: String) -> CmdResult<String> {
    let local = std::path::Path::new(&path);
    let size = std::fs::metadata(local)?.len();
    if size > 50 * 1024 * 1024 {
        return Err(anyhow!("文件过大（{} MB），上限 50MB", size / 1024 / 1024).into());
    }
    let name = local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let data = std::fs::read(local)?;
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    Ok(terminal::upload(&conn, "uploads", &name, &data).await?)
}

/// 把文本写到用户在系统「另存为」对话框里选的路径（导出对话用）
#[tauri::command]
fn save_text(path: String, text: String) -> CmdResult<()> {
    std::fs::write(path, text)?;
    Ok(())
}

#[tauri::command]
async fn chat_files(state: State<'_, AppState>, host_id: String, cwd: String) -> CmdResult<Vec<String>> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    Ok(chat::list_files(&conn, &cwd).await?)
}

/// 回答登录中途的验证码弹窗；answers 为 null 表示取消
#[tauri::command]
fn ssh_prompt_answer(state: State<'_, AppState>, id: String, answers: Option<Vec<String>>) {
    state.prompter.answer(&id, answers);
}

/// 把主窗口从托盘里叫出来
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 系统托盘：左键显示主窗口，右键菜单「显示 / 退出」。只有「退出」会真正结束应用
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "显示 cc-remote-station", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
    // 托盘用单独的透明底图标（icons/tray.png，由 tray-icon.svg 生成），比带底板的应用图标在 16px 下清爽。
    // macOS 菜单栏用单色模板图（只看透明度，系统按深浅色菜单栏自动着色），并按习惯左键弹菜单
    #[cfg(target_os = "macos")]
    let tray = TrayIconBuilder::with_id("main")
        .icon(tauri::include_image!("icons/tray-template.png"))
        .icon_as_template(true)
        .show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let tray = TrayIconBuilder::with_id("main")
        .icon(tauri::include_image!("icons/tray.png"))
        .show_menu_on_left_click(false);
    tray.tooltip("cc-remote-station")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return; // macOS 左键已经弹菜单
            }
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 关闭窗口 = 缩到托盘；第一次这样做时弹一条通知告诉用户在哪里退出
fn hide_to_tray(window: &tauri::Window) {
    let _ = window.hide();
    let app = window.app_handle();
    let Ok(dir) = app.path().app_config_dir() else { return };
    let marker = dir.join("tray-hint-shown");
    if marker.exists() {
        return;
    }
    let _ = std::fs::write(&marker, "");
    use tauri_plugin_notification::NotificationExt;
    let (title, body) = if cfg!(target_os = "macos") {
        ("cc-remote-station 仍在后台运行", "点 Dock 图标或菜单栏图标可以重新打开，⌘Q 或菜单栏图标 → 退出。")
    } else {
        ("cc-remote-station 已最小化到托盘", "终端和对话仍在后台运行。点托盘图标打开，右键可以退出。")
    };
    let _ = app.notification().builder().title(title).body(body).show();
}

/// 从 Dock / Finder 启动的 macOS 应用只拿到 /usr/bin:/bin 这样的最小 PATH，
/// Homebrew、nvm 装的 node/npx 都找不到。启动时从用户的登录 shell 读一次完整 PATH（5 秒超时）
#[cfg(target_os = "macos")]
fn load_login_path() {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    const MARK: &str = "__CCWS_PATH__";
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return;
            }
        }
    }
    let mut out = String::new();
    let _ = child.stdout.take().map(|mut s| s.read_to_string(&mut out));
    if let Some(path) = out.split(MARK).nth(1).filter(|p| !p.is_empty()) {
        // SAFETY: 启动时还没有其他线程读写环境变量
        unsafe { std::env::set_var("PATH", path) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    #[cfg(target_os = "macos")]
    load_login_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::Pending::default())
        // 点关闭（标题栏 ✕、Alt+F4、任务栏关闭、macOS 红灯）不退出，缩到托盘；真正退出走托盘菜单（macOS 还有 ⌘Q）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_to_tray(window);
            }
        })
        .setup(|app| {
            setup_tray(app)?;
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let settings_path = dir.join("settings.json");
            let settings = Arc::new(RwLock::new(Settings::load_or_init(&settings_path)?));
            let data_dir = app.path().app_data_dir()?;
            let guard = Arc::new(mcp::Guard::new(settings.clone(), &data_dir));
            let toolbox = Arc::new(mcp::Toolbox::new(settings.clone()));
            let approvals = Arc::new(mcp::Approvals::default());
            let mcp_port = tauri::async_runtime::block_on(mcp::serve(
                app.handle().clone(),
                guard.clone(),
                toolbox.clone(),
                HostStore::new(dir.join("hosts.json")),
                approvals.clone(),
                settings_path.clone(),
            ))?;
            app.manage(AppState {
                approvals,
                hosts: HostStore::new(dir.join("hosts.json")),
                known_hosts: dir.join("known_hosts"),
                settings,
                settings_path,
                ui_prefs_path: dir.join("ui.json"),
                cache_default: app.path().app_local_data_dir()?.join("chat-cache"),
                mcp_port,
                guard,
                toolbox,
                conns: Default::default(),
                connecting: Default::default(),
                prompter: ssh::Prompter::new(app.handle().clone()),
                terminals: Default::default(),
                chats: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hosts_list,
            host_save,
            host_delete,
            claude_mcp_state,
            claude_mcp_apply,
            claude_config_read,
            claude_config_set,
            quota_log,
            command_confirm_answer,
            host_check,
            update::update_check,
            update::update_install,
            terminal_open,
            ssh_prompt_answer,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_paste_image,
            tmux_sessions,
            tmux_kill,
            notify,
            settings_get,
            settings_save,
            settings_regen_token,
            toolbox_save,
            toolbox_test,
            toolbox_builtin,
            toolbox_import_scan,
            mcp_local_port,
            ui_prefs_get,
            ui_prefs_set,
            ssh_config_read,
            audit_days,
            audit_entries,
            backups_list,
            backup_restore,
            mcp_status,
            chat_start,
            chat_send,
            chat_stop,
            chat_sessions,
            chat_dirs,
            host_timezone,
            chat_history,
            chat_history_cached,
            chat_cache_info,
            chat_cache_set_dir,
            chat_cache_clear,
            chat_files,
            chat_delete,
            chat_upload,
            save_text
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // 工具箱启动的本机命令不会随应用退出自动结束
            tauri::RunEvent::Exit => app.state::<AppState>().toolbox.shutdown(),
            // macOS：窗口藏起来后点 Dock 图标重新打开
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
