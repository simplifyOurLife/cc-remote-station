use anyhow::{Result, ensure};
use russh::ChannelMsg;
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::AppState;
use crate::ssh::Conn;

pub enum Input {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct TermHandle {
    pub tx: mpsc::UnboundedSender<Input>,
    pub conn: Arc<Conn>,
    /// 开启 tmux 时该标签对应的远端会话名
    pub session: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    id: String,
    exit_code: Option<u32>,
}

/// 在已有连接上开一个带 PTY 的终端通道。远端输出原样（二进制）推给前端 xterm.js，
/// 不经过任何本地 PTY / ConPTY，转义序列不会被改写。
/// session 为 Some 时进入（或接回）同名 tmux 会话；远端没装 tmux 就退回普通登录 shell。
/// dir 为主机的默认工作目录：先 cd 进去（目录不存在就停在家目录），新建的 tmux 会话也从这里开始。
pub async fn open(
    app: AppHandle,
    id: String,
    conn: Arc<Conn>,
    cols: u32,
    rows: u32,
    session: Option<&str>,
    dir: Option<&str>,
    output: Channel<InvokeResponseBody>,
) -> Result<mpsc::UnboundedSender<Input>> {
    let mut channel = conn.handle.channel_open_session().await?;
    channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
    let cd = dir.map(|d| format!("cd {} 2>/dev/null; ", crate::chat::cd_target(d))).unwrap_or_default();
    match session {
        Some(name) => {
            // 只对本会话关掉状态栏（标签栏已有同样信息），并放行 OSC 透传和剪贴板，
            // 让通知（OSC 9/777）和远端复制（OSC 52）在 tmux 里也能到达本机。
            // mouse on：滚轮由 tmux 翻看自己的历史（tmux 里本地滚动缓冲没有内容），按住 Shift 仍可本地选中
            // -q：老版本 tmux 没有 allow-passthrough 时静默忽略
            let cmd = format!(
                "{cd}command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s {name} \
                 \\; set-option -q status off \
                 \\; set-option -q mouse on \
                 \\; set-option -qw allow-passthrough on \
                 \\; set-option -qs set-clipboard on \
                 || exec \"$SHELL\" -l"
            );
            channel.exec(false, cmd).await?;
        }
        None if dir.is_some() => channel.exec(false, format!("{cd}exec \"${{SHELL:-bash}}\" -l")).await?,
        None => channel.request_shell(false).await?,
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let _conn = conn;
        let mut exit_code = None;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = output.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                input = rx.recv() => match input {
                    Some(Input::Data(data)) => {
                        if channel.data(&data[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(Input::Resize(cols, rows)) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(Input::Close) | None => {
                        let _ = channel.close().await;
                        break;
                    }
                },
            }
        }
        app.state::<AppState>().terminals.lock().unwrap().remove(&id);
        // exit_code 为 None 表示不是远端程序正常退出（断线等），前端据此自动重连
        let _ = app.emit("terminal-exit", ExitEvent { id, exit_code });
    });
    Ok(tx)
}

/// 把剪贴板图片写到远端，返回远端绝对路径
pub async fn upload_clipboard_image(conn: &Conn, png: &[u8]) -> Result<String> {
    upload(conn, "clipboard", "clip.png", png).await
}

/// 把本机文件传到远端 ~/.cache/cc-workstation/<kind>/，文件名加时间戳前缀避免重名，返回远端绝对路径。
/// 顺手清理该目录里 7 天前的旧文件，避免无限堆积。
pub async fn upload(conn: &Conn, kind: &str, name: &str, data: &[u8]) -> Result<String> {
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis();
    // 文件名会拼进远端命令，只保留安全字符（中文等非 ASCII 字符也保留）
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let file = format!("{millis}-{safe}");
    let cmd = format!(
        "d=\"$HOME/.cache/cc-workstation/{kind}\"; mkdir -p \"$d\" && \
         find \"$d\" -type f -mtime +7 -delete 2>/dev/null; \
         cat > \"$d/{file}\" && printf %s \"$d/{file}\""
    );
    let out = conn.exec(&cmd, Some(data)).await?;
    ensure!(out.code == 0, "上传失败：{}", String::from_utf8_lossy(&out.stderr).trim());
    Ok(String::from_utf8(out.stdout)?)
}

pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(rgba)?;
    }
    Ok(out)
}
