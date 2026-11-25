//! 图形对话：在云主机上以 stream-json 模式运行官方 claude，后端只做 NDJSON 管道。
//! 协议（消息、审批、中断、切换模型）全部由前端组装和解析。

use anyhow::{Context, Result, ensure};
use russh::ChannelMsg;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::AppState;
use crate::ssh::Conn;

/// 非交互 shell 不加载 .bashrc（常见的 nvm 在里面），显式补上 claude 的常见安装位置
macro_rules! claude_path {
    () => {
        "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:$PATH\"; \
         [ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; "
    };
}
/// 只补 PATH，不检查 claude 是否存在（环境检查用）
pub const CLAUDE_PATH: &str = claude_path!();
/// 补 PATH 并确认 claude 存在，没有就以 127 退出
pub const CLAUDE_PATH_SETUP: &str = concat!(
    claude_path!(),
    "command -v claude >/dev/null 2>&1 || { echo '未找到 claude 命令，云主机可能没装 Claude Code。可在工作区启动台的「检查云主机环境」里查看安装方法' >&2; exit 127; }; "
);

const PERMISSION_MODES: [&str; 4] = ["default", "acceptEdits", "plan", "bypassPermissions"];

pub struct ChatHandle {
    pub tx: mpsc::UnboundedSender<String>,
}

pub struct StartOptions {
    pub cwd: String,
    pub resume: Option<String>,
    /// 与 resume 同时使用：在新会话里接着聊，原会话保持不变
    pub fork: bool,
    pub model: Option<String>,
    pub permission_mode: String,
    /// 每轮结束后发 prompt_suggestion（预测下一句）
    pub prompt_suggestions: bool,
}

/// 启动云端 claude 进程。stdout 每行 JSON 原样推给前端；stderr 包成 {type:"stderr"}；
/// 进程结束发 {type:"exit"}。返回的 tx 用来写 stdin（每条一行 JSON）。
pub async fn start(
    app: AppHandle,
    id: String,
    conn: Arc<Conn>,
    opts: StartOptions,
    events: Channel<Value>,
) -> Result<mpsc::UnboundedSender<String>> {
    ensure!(PERMISSION_MODES.contains(&opts.permission_mode.as_str()), "未知权限模式");
    let mut args = format!(
        "claude -p --input-format stream-json --output-format stream-json --verbose \
         --include-partial-messages --permission-prompt-tool stdio --permission-mode {}",
        opts.permission_mode
    );
    if let Some(m) = &opts.model {
        args.push_str(&format!(" --model {}", shell_quote(m)));
    }
    if let Some(r) = &opts.resume {
        ensure!(r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "非法的会话 id");
        args.push_str(&format!(" --resume {r}"));
        if opts.fork {
            args.push_str(" --fork-session");
        }
    }
    // 预测下一句：实测（2.1.330）参数和环境变量要同时给才会发 prompt_suggestion
    let suggest_env = if opts.prompt_suggestions {
        args.push_str(" --prompt-suggestions true");
        "export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1; "
    } else {
        ""
    };
    let script = format!("{CLAUDE_PATH_SETUP}{suggest_env}cd {} || exit 1; exec {args}", cd_target(&opts.cwd));
    let mut channel = conn.open_channel().await?;
    channel.exec(true, format!("bash -lc {}", shell_quote(&script))).await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let _conn = conn;
        let (mut out_buf, mut err_buf) = (Vec::new(), Vec::new());
        let mut code = None;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        out_buf.extend_from_slice(&data);
                        for line in take_lines(&mut out_buf) {
                            let value = serde_json::from_str(&line)
                                .unwrap_or_else(|_| json!({ "type": "stdout", "text": line }));
                            let _ = events.send(value);
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        err_buf.extend_from_slice(&data);
                        for line in take_lines(&mut err_buf) {
                            let _ = events.send(json!({ "type": "stderr", "text": line }));
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                line = rx.recv() => match line {
                    Some(line) => {
                        if channel.data(format!("{line}\n").as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        break;
                    }
                },
            }
        }
        // 没以换行结尾的最后一行 stderr 往往正是报错原因
        if !err_buf.is_empty() {
            let _ = events.send(json!({ "type": "stderr", "text": String::from_utf8_lossy(&err_buf) }));
        }
        app.state::<AppState>().chats.lock().unwrap().remove(&id);
        let _ = events.send(json!({ "type": "exit", "code": code }));
    });
    Ok(tx)
}

/// 从缓冲区取出所有完整行，剩余半行留在缓冲区
fn take_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        return vec![];
    };
    let rest = buf.split_off(last_nl + 1);
    let complete = std::mem::replace(buf, rest);
    String::from_utf8_lossy(&complete)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// ~/.claude/projects 下的相对路径，读历史时传回来
    pub file: String,
    pub session_id: String,
    pub cwd: String,
    /// 第一条用户消息（或 summary），作为列表标题
    pub title: String,
    /// 最后修改时间，Unix 秒
    pub mtime: u64,
}

/// 列出云端最近的 Claude Code 会话。每个 jsonl 取两部分：
/// - 开头 24KB里第一条带 cwd 的行和前 5 条用户行：解析 cwd 和第一条用户消息
///   （在云端就筛掉大块元数据，输出从几百 KB 降到几十 KB，再 gzip）；
/// - 行首锚定 grep 出的标题记录（custom-title / ai-title / summary / last-prompt）。
///   新版会话开头是一串元数据和几十 KB 的大行，第一条用户消息往往不在开头，标题记录才可靠。
/// 目录名以 - 开头（如 -home-ubuntu-xxx），ls / stat / head 都要加 --，否则会被当成选项。
///
/// dir 有值时只读这个工作目录的会话：Claude Code 把每个目录的会话放在 ~/.claude/projects/<编码后的绝对路径>，
/// 编码规则是把非字母数字字符都换成 -。路径先用 pwd -P 解析（claude 看到的是解开符号链接后的真实路径）。
/// dir 为 None 时扫全部目录最近的 150 个。
pub async fn list_sessions(conn: &Arc<Conn>, dir: Option<&str>) -> Result<Vec<SessionInfo>> {
    let pick = match dir {
        Some(d) => format!(
            "d=$(cd {} 2>/dev/null && pwd -P) || exit 0; cd ~/.claude/projects 2>/dev/null || exit 0; \
             p=$(printf %s \"$d\" | sed 's/[^a-zA-Z0-9]/-/g'); ls -t -- \"$p\"/*.jsonl 2>/dev/null | head -n 150",
            cd_target(d)
        ),
        None => "cd ~/.claude/projects 2>/dev/null || exit 0; ls -t -- */*.jsonl 2>/dev/null | head -n 150".to_string(),
    };
    let script = format!(
        "{pick} | while IFS= read -r f; do \
          printf '\\036%s\\t%s\\n' \"$f\" \"$(stat -c %Y -- \"$f\")\"; \
          head -c 24000 -- \"$f\" | grep -a -m 1 '\"cwd\":'; head -c 24000 -- \"$f\" | grep -a -m 5 '\"type\":\"user\"'; echo; \
          grep -h '^{{\"type\":\"\\(custom-title\\|ai-title\\|summary\\|last-prompt\\)\"' -- \"$f\" | tail -n 8; \
        done | gzip -1"
    );
    let out = conn.exec(&format!("bash -c {}", shell_quote(&script)), None).await?;
    let mut raw = Vec::new();
    // 目录不存在时脚本提前 exit 0，没有输出
    if !out.stdout.is_empty() {
        std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&out.stdout[..]), &mut raw).context("解压会话列表失败")?;
    }
    let text = String::from_utf8_lossy(&raw);
    let mut sessions = Vec::new();
    for record in text.split('\x1e').filter(|r| !r.is_empty()) {
        let Some((head, body)) = record.split_once('\n') else { continue };
        let Some((file, mtime)) = head.split_once('\t') else { continue };
        let session_id = file.rsplit('/').next().unwrap_or(file).trim_end_matches(".jsonl").to_string();
        let (mut cwd, mut first_user) = (String::new(), String::new());
        let (mut custom, mut ai, mut summary, mut last_prompt) = (String::new(), String::new(), String::new(), String::new());
        for line in body.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            if cwd.is_empty() {
                if let Some(c) = v["cwd"].as_str() {
                    cwd = c.to_string();
                }
            }
            let field = |key: &str| v[key].as_str().unwrap_or_default().trim().to_string();
            // 标题记录可能出现多次（重命名、重新生成），取最后一条非空的
            match v["type"].as_str() {
                Some("custom-title") if !field("customTitle").is_empty() => custom = field("customTitle"),
                Some("ai-title") if !field("aiTitle").is_empty() => ai = field("aiTitle"),
                Some("summary") if !field("summary").is_empty() => summary = field("summary"),
                Some("last-prompt") if !field("lastPrompt").is_empty() => last_prompt = field("lastPrompt"),
                Some("user") if first_user.is_empty() && v["isMeta"] != json!(true) => {
                    first_user = readable_title(&user_text(&v["message"]["content"]));
                }
                _ => {}
            }
        }
        // 优先用户自己起的名字，其次 AI 标题、摘要、第一条消息、最后一次输入
        let title = [custom, ai, summary, first_user, last_prompt]
            .into_iter()
            .find(|t| !t.is_empty())
            .unwrap_or_default();
        // 什么都取不到的是打开就关掉的空会话（终端里的 /resume 同样不列）
        if title.is_empty() {
            continue;
        }
        sessions.push(SessionInfo {
            file: file.to_string(),
            session_id,
            cwd,
            title: title.chars().take(120).collect(),
            mtime: mtime.trim().parse().unwrap_or(0),
        });
    }
    Ok(sessions)
}

/// 最近用过的工作目录（新的在前）：取每个项目文件夹里最新会话开头的 cwd。
/// 文件夹名是有损编码（- 分不清是 / 还是 .），所以从会话内容里取真实路径
pub async fn recent_dirs(conn: &Arc<Conn>) -> Result<Vec<String>> {
    let script = "cd ~/.claude/projects 2>/dev/null || exit 0; \
        ls -td -- */ 2>/dev/null | head -n 40 | while IFS= read -r d; do \
          f=$(ls -t -- \"$d\"*.jsonl 2>/dev/null | head -n 1); \
          [ -n \"$f\" ] && head -c 24000 -- \"$f\" | grep -o '\"cwd\":\"[^\"]*\"' | head -n 1; \
        done";
    let out = conn.exec(&format!("bash -c {}", shell_quote(script)), None).await?;
    let mut dirs: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // 每行是 "cwd":"..."，包成 JSON 对象解析，顺便处理转义
        let Ok(v) = serde_json::from_str::<Value>(&format!("{{{line}}}")) else { continue };
        if let Some(cwd) = v["cwd"].as_str().filter(|c| !c.is_empty()) {
            if !dirs.iter().any(|d| d == cwd) {
                dirs.push(cwd.to_string());
            }
        }
    }
    Ok(dirs)
}

/// 斜杠命令在会话里存成 <command-name>/model</command-name>…，做标题时只留命令名
fn readable_title(text: &str) -> String {
    text.strip_prefix("<command-name>")
        .and_then(|rest| rest.split_once("</command-name>"))
        .map(|(name, _)| name.trim().to_string())
        .unwrap_or_else(|| text.to_string())
}

/// 取用户消息里的纯文本；只含 tool_result 的（工具回传）返回空
fn user_text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.trim().to_string();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// 历史里每段工具输入/输出最多保留的字符数（卡片默认只显示前 3000 字）
const HISTORY_KEEP_CHARS: usize = 20_000;

/// 第一次读（或缓存对不上）时只取会话文件最后这么多字节，足够显示近期上下文
const HISTORY_TAIL: u64 = 3_000_000;

/// 本机缓存的一个会话：已读到云端文件的哪个字节（总在行尾），以及该位置之前 4KB 的 sha256（云端算的），
/// 下次据此确认文件前面没变、只增量拉新增的部分。会话文件只追加（继续聊、改标题、压缩都是追加新行）
#[derive(Serialize, serde::Deserialize)]
struct Cached {
    offset: u64,
    check: String,
    lines: Vec<Value>,
}

fn read_cache(path: &Path) -> Option<Cached> {
    let file = std::fs::File::open(path).ok()?;
    let c: Cached = serde_json::from_reader(flate2::read::GzDecoder::new(std::io::BufReader::new(file))).ok()?;
    // 记一下最近用过，超出容量时按它淘汰
    let _ = std::fs::File::options().write(true).open(path).and_then(|f| f.set_modified(std::time::SystemTime::now()));
    Some(c)
}

/// 只读本机缓存（不连云端），打开会话时先拿它显示
pub fn cached_history(path: &Path) -> Option<Vec<Value>> {
    read_cache(path).map(|c| c.lines)
}

fn write_cache(path: &Path, c: &Cached) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    let mut gz = flate2::write::GzEncoder::new(std::io::BufWriter::new(std::fs::File::create(&tmp)?), flate2::Compression::fast());
    serde_json::to_writer(&mut gz, c)?;
    std::io::Write::flush(&mut gz.finish()?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// 读取某个会话的历史，返回瘦身后的用户/Claude 消息行。cache 为本机缓存文件：
/// - 缓存对得上（文件没变小、读到位置前 4KB 的哈希一致）就只拉新增部分，老会话等于直接读本地；
/// - 否则（没缓存、文件被重建）取最后 3MB 重来。
/// 云端只交到最后一个完整行为止（正在写的半行留到下次），先滤掉界面用不上的大块内部记录再 gzip 传输。
/// 输出第一行是「模式 读到的位置 该位置的校验」，后面是 gzip 数据
pub async fn history(conn: &Arc<Conn>, file: &str, cache: Option<&Path>) -> Result<Vec<Value>> {
    ensure!(!file.contains("..") && file.ends_with(".jsonl"), "非法的会话文件");
    let cached = cache.and_then(read_cache).filter(|c| c.check.len() == 64 && c.check.chars().all(|ch| ch.is_ascii_hexdigit()));
    let (off, check) = cached.as_ref().map_or((0, String::new()), |c| (c.offset, c.check.clone()));
    let script = r#"
f=~/.claude/projects/__FILE__
[ -r "$f" ] || { echo 会话文件不存在 >&2; exit 1; }
size=$(stat -c %s -- "$f")
win() { w=$(( $1 < 4096 ? $1 : 4096 )); tail -c +$(( $1 - w + 1 )) -- "$f" | head -c $w | sha256sum | cut -c1-64; }
off=__OFF__
if [ $off -gt 0 ] && [ $size -ge $off ] && [ "$(win $off)" = "__CHECK__" ]; then
  mode=inc; start=$off
else
  mode=full; start=$(( size > __TAIL__ ? size - __TAIL__ : 0 ))
fi
end=$size
if [ $end -gt $start ] && [ "$(tail -c +$end -- "$f" | head -c 1 | od -An -tx1 | tr -d ' \n')" != 0a ]; then
  end=$(( end - $(tail -c +$(( start + 1 )) -- "$f" | head -c $(( end - start )) | tail -n 1 | wc -c) ))
fi
printf '%s %s %s\n' $mode $end "$(win $end)"
tail -c +$(( start + 1 )) -- "$f" | head -c $(( end - start )) \
  | grep -av '^{"type":"\(api-request-blob\|api-request\|file-history-snapshot\)"' | gzip -1
"#
    .replace("__FILE__", &shell_quote(file))
    .replace("__OFF__", &off.to_string())
    .replace("__CHECK__", &check)
    .replace("__TAIL__", &HISTORY_TAIL.to_string());
    let out = conn.exec(&format!("bash -c {}", shell_quote(&script)), None).await?;
    ensure!(out.code == 0, "读取会话失败：{}", String::from_utf8_lossy(&out.stderr).trim());
    let nl = out.stdout.iter().position(|&b| b == b'\n').context("读取会话失败：云端输出格式不对")?;
    let head = String::from_utf8_lossy(&out.stdout[..nl]).to_string();
    let mut parts = head.split(' ');
    let (mode, end, new_check) = (parts.next().unwrap_or(""), parts.next().and_then(|s| s.parse::<u64>().ok()), parts.next().unwrap_or(""));
    let end = end.context("读取会话失败：云端输出格式不对")?;
    let mut raw = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&out.stdout[nl + 1..]), &mut raw).context("解压会话历史失败")?;
    let text = String::from_utf8_lossy(&raw);
    // 从文件中间开始读时第一行是半行，解析失败的行直接跳过
    let fresh = text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(slim_line);
    let lines: Vec<Value> = match (mode, cached) {
        ("inc", Some(c)) => c.lines.into_iter().chain(fresh).collect(),
        _ => fresh.collect(),
    };
    if let Some(path) = cache {
        let c = Cached { offset: end, check: new_check.to_string(), lines };
        // 写缓存失败（磁盘满、目录没权限）不影响这次显示
        if let Err(e) = write_cache(path, &c) {
            log::warn!("写会话缓存失败 {}: {e:#}", path.display());
        }
        return Ok(c.lines);
    }
    Ok(lines)
}

/// 会话缓存的容量上限，超出时按最久没打开的先删
const CACHE_CAP: u64 = 500 * 1024 * 1024;

fn safe_segment(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect()
}

/// 会话缓存文件：<缓存目录>/<主机 id>/<会话文件路径>.json.gz（路径里的 / 换成 __）
pub fn cache_path(root: &Path, host_id: &str, file: &str) -> PathBuf {
    root.join(safe_segment(host_id)).join(format!("{}.json.gz", safe_segment(&file.replace('/', "__"))))
}

/// 缓存目录里本应用写的文件（只认主机子目录下的 *.json.gz，用户选的目录里别的东西不碰）：路径、大小、最近使用时间
fn cache_files(root: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let mut out = Vec::new();
    for host in std::fs::read_dir(root).into_iter().flatten().flatten() {
        if !host.path().is_dir() {
            continue;
        }
        for f in std::fs::read_dir(host.path()).into_iter().flatten().flatten() {
            let p = f.path();
            if !p.to_string_lossy().ends_with(".json.gz") {
                continue;
            }
            if let Ok(m) = f.metadata() {
                out.push((p, m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)));
            }
        }
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub dir: String,
    pub default_dir: String,
    pub bytes: u64,
    pub sessions: usize,
}

pub fn cache_info(root: &Path, default_root: &Path) -> CacheInfo {
    let files = cache_files(root);
    CacheInfo {
        dir: root.display().to_string(),
        default_dir: default_root.display().to_string(),
        bytes: files.iter().map(|f| f.1).sum(),
        sessions: files.len(),
    }
}

/// 超出容量就从最久没打开的删起
pub fn cache_prune(root: &Path) {
    let mut files = cache_files(root);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= CACHE_CAP {
        return;
    }
    files.sort_by_key(|f| f.2);
    for (p, len, _) in files {
        if total <= CACHE_CAP * 9 / 10 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}

/// 清空缓存：只删本应用写的缓存文件和随之变空的主机子目录
pub fn cache_clear(root: &Path) {
    for (p, _, _) in cache_files(root) {
        let _ = std::fs::remove_file(&p);
        if let Some(dir) = p.parent() {
            let _ = std::fs::remove_dir(dir); // 非空时失败，正好不删
        }
    }
}

/// 只留前端 fromHistory 用到的字段；工具输入/输出截短，工具结果里的图片只留占位
fn slim_line(mut v: Value) -> Option<Value> {
    if v["isMeta"] == true || v["isSidechain"] == true {
        return None;
    }
    // 压缩点：界面在这里插一条「上下文已压缩」
    if v["type"] == "system" && v["subtype"] == "compact_boundary" {
        return Some(json!({ "type": "system", "subtype": "compact_boundary", "timestamp": v["timestamp"].take(), "preTokens": v["compactMetadata"]["preTokens"].take() }));
    }
    if !matches!(v["type"].as_str(), Some("user" | "assistant")) {
        return None;
    }
    if let Some(content) = v.pointer_mut("/message/content").and_then(Value::as_array_mut) {
        for b in content {
            match b["type"].as_str() {
                Some("tool_result") => match &mut b["content"] {
                    Value::String(s) => clip(s),
                    Value::Array(parts) => {
                        for p in parts {
                            if p["type"] == "image" {
                                *p = json!({ "type": "image" });
                            } else if let Some(Value::String(s)) = p.get_mut("text") {
                                clip(s);
                            }
                        }
                    }
                    _ => {}
                },
                Some("tool_use") => {
                    if let Some(Value::Object(input)) = b.get_mut("input") {
                        input.values_mut().for_each(|x| if let Value::String(s) = x { clip(s) });
                    }
                }
                _ => {}
            }
        }
    }
    Some(json!({
        "type": v["type"].take(),
        "timestamp": v["timestamp"].take(),
        "message": v["message"].take(),
        "isCompactSummary": v["isCompactSummary"].take(),
    }))
}

fn clip(s: &mut String) {
    if let Some((cut, _)) = s.char_indices().nth(HISTORY_KEEP_CHARS) {
        let kb = s.len() / 1024;
        s.truncate(cut);
        s.push_str(&format!("\n…（历史记录已截断，原文共 {kb} KB）"));
    }
}

/// 删除云端会话文件（~/.claude/projects 下的某个 jsonl）
pub async fn delete_session(conn: &Arc<Conn>, file: &str) -> Result<()> {
    ensure!(!file.contains("..") && file.ends_with(".jsonl"), "非法的会话文件");
    let out = conn.exec(&format!("rm -f ~/.claude/projects/{}", shell_quote(file)), None).await?;
    ensure!(out.code == 0, "删除失败：{}", String::from_utf8_lossy(&out.stderr).trim());
    Ok(())
}

/// 列出工作目录下的文件（给 @ 引用补全用）；git 仓库用 git ls-files，否则 find
pub async fn list_files(conn: &Arc<Conn>, cwd: &str) -> Result<Vec<String>> {
    let script = format!(
        "cd {} 2>/dev/null || exit 0; \
         git ls-files 2>/dev/null | head -n 20000 || true; \
         git rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
           find . -type f -not -path '*/.*' -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\\./||' | head -n 20000",
        cd_target(cwd)
    );
    let out = conn.exec(&format!("bash -c {}", shell_quote(&script)), None).await?;
    Ok(String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect())
}

/// cd 的目标：只展开开头的 ~，其余原样加引号。不用 eval——目录可能来自云端会话记录，不能当命令执行
pub fn cd_target(cwd: &str) -> String {
    match cwd.strip_prefix('~') {
        Some(rest) => format!("\"$HOME\"{}", shell_quote(rest)),
        None => shell_quote(cwd),
    }
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 仅供 lib.rs 取连接时使用的小工具：按 chat id 拿到写入端
pub fn send(state: &AppState, id: &str, line: String) -> Result<()> {
    let chats = state.chats.lock().unwrap();
    let chat = chats.get(id).context("对话进程已结束")?;
    chat.tx.send(line).ok().context("对话进程已结束")
}
