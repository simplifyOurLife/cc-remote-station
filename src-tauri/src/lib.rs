mod chat;
mod hosts;
mod mcp;
mod settings;
mod ssh;
mod terminal;

use anyhow::{Context, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use hosts::{Host, HostStore};
use settings::Settings;
use ssh::{Conn, Credentials, McpForward, NeedSecret, TrustedKey, UnknownHostKey};
use terminal::{Input, TermHandle};

pub struct AppState {
    hosts: HostStore,
    known_hosts: PathBuf,
    settings: Arc<RwLock<Settings>>,
    settings_path: PathBuf,
    /// 前端界面偏好（终端外观、快捷命令等），原样存取的 JSON
    ui_prefs_path: PathBuf,
    /// 内置 MCP 服务在本机监听的端口
    mcp_port: u16,
    /// MCP 的白名单/审计/备份，界面用它查看记录和恢复备份
    guard: Arc<mcp::Guard>,
    /// 按主机复用连接：同一台主机的多个终端和 MCP 转发走同一条 SSH 连接
    conns: tokio::sync::Mutex<HashMap<String, Arc<Conn>>>,
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

/// 取该主机已有的连接，没有（或已断）就新建；返回的 bool 表示是否新建
async fn get_or_connect(
    state: &AppState,
    host_id: &str,
    trust: Option<&TrustedKey>,
    creds: &Credentials,
) -> anyhow::Result<(Arc<Conn>, bool)> {
    let mut conns = state.conns.lock().await;
    if let Some(c) = conns.get(host_id).filter(|c| !c.handle.is_closed()) {
        return Ok((c.clone(), false));
    }
    let host = state.hosts.get(host_id)?;
    let mcp = host.mcp.then(|| McpForward {
        local_port: state.mcp_port,
        remote_port: state.settings.read().unwrap().remote_port,
    });
    let conn = Arc::new(ssh::connect(&state.hosts, &state.known_hosts, &host, trust, creds, mcp).await?);
    conns.insert(host_id.to_string(), conn.clone());
    Ok((conn, true))
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
    let notice = match (&conn.mcp_forward, fresh) {
        (Some(Err(e)), true) => Some(e.clone()),
        _ => None,
    };
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

/// 列出该主机上 cc-workstation 建的 tmux 会话（ccws- 前缀），用于接回或清理
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
    allow_commands: bool,
    remote_port: u16,
}

#[tauri::command]
fn settings_save(state: State<AppState>, patch: SettingsPatch) -> CmdResult<Settings> {
    let mut s = state.settings.write().unwrap();
    s.roots = patch.roots;
    s.allow_commands = patch.allow_commands;
    s.remote_port = patch.remote_port;
    s.save(&state.settings_path)?;
    Ok(s.clone())
}

/// 换新令牌后，已配置的云端 Claude Code 需要重新「一键配置」
#[tauri::command]
fn settings_regen_token(state: State<AppState>) -> CmdResult<Settings> {
    let mut s = state.settings.write().unwrap();
    s.token = settings::new_token();
    s.save(&state.settings_path)?;
    Ok(s.clone())
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
    /// "ok" / "error"
    state: &'static str,
    /// ok 时为云端端口，error 时为原因
    detail: String,
}

/// 当前在线连接上的 MCP 反向转发状态；未连接或未开启的主机不列出
#[tauri::command]
async fn mcp_status(state: State<'_, AppState>) -> CmdResult<Vec<McpHostStatus>> {
    let conns = state.conns.lock().await;
    let mut list = Vec::new();
    for (host_id, conn) in conns.iter().filter(|(_, c)| !c.handle.is_closed()) {
        let (st, detail) = match &conn.mcp_forward {
            Some(Ok(port)) => ("ok", port.to_string()),
            Some(Err(e)) => ("error", e.clone()),
            None => continue,
        };
        list.push(McpHostStatus { host_id: host_id.clone(), state: st, detail });
    }
    Ok(list)
}

/// 读取 ~/.ssh/config 原文（不存在返回空串），由前端解析后让用户勾选导入
#[tauri::command]
fn ssh_config_read() -> String {
    dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".ssh").join("config")).ok())
        .unwrap_or_default()
}

/// 在云主机上执行 claude mcp add，把本机 MCP（经反向转发的云端端口）配给云端 Claude Code
#[tauri::command]
async fn host_setup_claude(state: State<'_, AppState>, host_id: String) -> CmdResult<String> {
    let conn = {
        let conns = state.conns.lock().await;
        conns.get(&host_id).filter(|c| !c.handle.is_closed()).cloned()
    }
    .context("请先打开这台主机的终端，连接建立后再配置")?;
    let port = match &conn.mcp_forward {
        Some(Ok(port)) => *port,
        Some(Err(e)) => return Err(anyhow!("MCP 反向转发未建立：{e}").into()),
        None => return Err(anyhow!("这台主机未开启「允许访问本机」，请编辑主机勾选后重新连接").into()),
    };
    let token = state.settings.read().unwrap().token.clone();
    // 不用交互 shell：.bashrc 里的自动 tmux / 提示等在无终端时会卡住
    let script = format!(
        "{}claude mcp remove ccws -s user >/dev/null 2>&1; \
         claude mcp add --transport http -s user ccws http://127.0.0.1:{port}/mcp --header 'Authorization: Bearer {token}'",
        chat::CLAUDE_PATH_SETUP
    );
    let cmd = format!("bash -lc {} </dev/null", chat::shell_quote(&script));
    let out = tokio::time::timeout(std::time::Duration::from_secs(30), conn.exec(&cmd, None))
        .await
        .context("云端命令 30 秒未返回，可能是登录脚本（~/.bash_profile 等）在等待输入")??;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.code != 0 {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("云端执行 claude mcp add 失败（退出码 {}）：{stdout}\n{}", out.code, stderr.trim()).into());
    }
    Ok(stdout)
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

#[tauri::command]
async fn chat_sessions(state: State<'_, AppState>, host_id: String) -> CmdResult<Vec<chat::SessionInfo>> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    Ok(chat::list_sessions(&conn).await?)
}

#[tauri::command]
async fn chat_history(state: State<'_, AppState>, host_id: String, file: String) -> CmdResult<Vec<Value>> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    Ok(chat::history(&conn, &file).await?)
}

#[tauri::command]
async fn chat_delete(state: State<'_, AppState>, host_id: String, file: String) -> CmdResult<()> {
    let (conn, _) = get_or_connect(&state, &host_id, None, &Credentials::default()).await?;
    Ok(chat::delete_session(&conn, &file).await?)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&dir)?;
            let settings_path = dir.join("settings.json");
            let settings = Arc::new(RwLock::new(Settings::load_or_init(&settings_path)?));
            let data_dir = app.path().app_data_dir()?;
            let guard = Arc::new(mcp::Guard::new(settings.clone(), &data_dir));
            let mcp_port = tauri::async_runtime::block_on(mcp::serve(app.handle().clone(), guard.clone()))?;
            app.manage(AppState {
                hosts: HostStore::new(dir.join("hosts.json")),
                known_hosts: dir.join("known_hosts"),
                settings,
                settings_path,
                ui_prefs_path: dir.join("ui.json"),
                mcp_port,
                guard,
                conns: Default::default(),
                terminals: Default::default(),
                chats: Default::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hosts_list,
            host_save,
            host_delete,
            host_setup_claude,
            terminal_open,
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
            chat_history,
            chat_files,
            chat_delete,
            chat_upload,
            save_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
