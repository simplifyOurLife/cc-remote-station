//! 图形对话：在云主机上以 stream-json 模式运行官方 claude，后端只做 NDJSON 管道。
//! 协议（消息、审批、中断、切换模型）全部由前端组装和解析。

use anyhow::{Context, Result, ensure};
use russh::ChannelMsg;
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::AppState;
use crate::ssh::Conn;

/// 非交互 shell 不加载 .bashrc（常见的 nvm 在里面），显式补上 claude 的常见安装位置
pub const CLAUDE_PATH_SETUP: &str = "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:$PATH\"; \
     [ -s \"$HOME/.nvm/nvm.sh\" ] && . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; \
     command -v claude >/dev/null 2>&1 || { echo '未找到 claude 命令，请确认云主机已安装 Claude Code' >&2; exit 127; }; ";

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
    let script = format!("{CLAUDE_PATH_SETUP}cd {} || exit 1; exec {args}", cd_target(&opts.cwd));
    let mut channel = conn.handle.channel_open_session().await?;
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
/// - 开头 24KB：解析 cwd 和第一条用户消息；
/// - 行首锚定 grep 出的标题记录（custom-title / ai-title / summary / last-prompt）。
///   新版会话开头是一串元数据和几十 KB 的大行，第一条用户消息往往不在开头，标题记录才可靠。
/// 目录名以 - 开头（如 -home-ubuntu-xxx），ls / stat / head 都要加 --，否则会被当成选项。
///
/// dir 有值时只读这个工作目录的会话：Claude Code 把每个目录的会话放在 ~/.claude/projects/<编码后的绝对路径>，
/// 编码规则是把非字母数字字符都换成 -。路径先用 pwd -P 解析（claude 看到的是解开符号链接后的真实路径）。
/// dir 为 None 时扫全部目录最近的 150 个。
pub async fn list_sessions(conn: &Conn, dir: Option<&str>) -> Result<Vec<SessionInfo>> {
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
          printf '\\036%s\\t%s\\n' \"$f\" \"$(stat -c %Y -- \"$f\")\"; head -c 24000 -- \"$f\"; echo; \
          grep -h '^{{\"type\":\"\\(custom-title\\|ai-title\\|summary\\|last-prompt\\)\"' -- \"$f\" | tail -n 8; \
        done"
    );
    let out = conn.exec(&format!("bash -c {}", shell_quote(&script)), None).await?;
    let text = String::from_utf8_lossy(&out.stdout);
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
pub async fn recent_dirs(conn: &Conn) -> Result<Vec<String>> {
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

/// 读取某个会话的历史（只取最后 3MB，足够显示近期上下文），返回解析好的行
pub async fn history(conn: &Conn, file: &str) -> Result<Vec<Value>> {
    ensure!(!file.contains("..") && file.ends_with(".jsonl"), "非法的会话文件");
    let cmd = format!("tail -c 3000000 ~/.claude/projects/{}", shell_quote(file));
    let out = conn.exec(&cmd, None).await?;
    ensure!(out.code == 0, "读取会话失败：{}", String::from_utf8_lossy(&out.stderr).trim());
    let text = String::from_utf8_lossy(&out.stdout);
    // tail 可能从半行开始，解析失败的行直接跳过
    Ok(text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
}

/// 删除云端会话文件（~/.claude/projects 下的某个 jsonl）
pub async fn delete_session(conn: &Conn, file: &str) -> Result<()> {
    ensure!(!file.contains("..") && file.ends_with(".jsonl"), "非法的会话文件");
    let out = conn.exec(&format!("rm -f ~/.claude/projects/{}", shell_quote(file)), None).await?;
    ensure!(out.code == 0, "删除失败：{}", String::from_utf8_lossy(&out.stderr).trim());
    Ok(())
}

/// 列出工作目录下的文件（给 @ 引用补全用）；git 仓库用 git ls-files，否则 find
pub async fn list_files(conn: &Conn, cwd: &str) -> Result<Vec<String>> {
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
