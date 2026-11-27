//! 对话里点文件路径时的预览：读云主机上的文件（文本前 1MB、图片）、批量查路径是否存在、下载到本机
use crate::chat::shell_quote;
use crate::ssh::Conn;
use anyhow::{Result, bail};
use base64::Engine;
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

/// 文本只读前 1MB
const TEXT_LIMIT: u64 = 1 << 20;
const IMAGE_LIMIT: u64 = 10 << 20;
const DOWNLOAD_LIMIT: u64 = 200 << 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    /// 解析后的绝对路径
    path: String,
    size: u64,
    /// 修改时间，Unix 秒
    mtime: i64,
    /// text / image / binary
    kind: &'static str,
    text: Option<String>,
    /// 图片的 data URL
    image: Option<String>,
    /// 只读了一部分
    truncated: bool,
}

/// 脚本开头：x 展开开头的 ~，先 cd 到 $1（对话的工作目录），相对路径按它解析
const PRELUDE: &str = r#"x() { case $1 in '~') printf %s "$HOME";; '~/'*) printf %s "$HOME/${1#'~/'}";; *) printf %s "$1";; esac; }; cd "$(x "$1")" 2>/dev/null; "#;

/// 路径等都作为位置参数传进去，不拼进脚本
fn script(body: &str, args: &[&str]) -> String {
    let mut s = format!("bash -c {} _", shell_quote(&format!("{PRELUDE}{body}")));
    for a in args {
        s.push(' ');
        s.push_str(&shell_quote(a));
    }
    s
}

fn image_mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        // 放在 <img> 里，里面的脚本不会执行
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn fail(code: u32, path: &str, stderr: &[u8]) -> anyhow::Error {
    match code {
        3 => anyhow::anyhow!("文件不存在：{path}"),
        4 => anyhow::anyhow!("{path} 是目录"),
        _ => anyhow::anyhow!("读取失败：{}", String::from_utf8_lossy(stderr).trim()),
    }
}

pub async fn read(conn: &Arc<Conn>, cwd: &str, path: &str) -> Result<FilePreview> {
    let mime = image_mime(path);
    let limit = if mime.is_some() { IMAGE_LIMIT } else { TEXT_LIMIT };
    let cmd = script(
        r#"p=$(x "$2"); [ -e "$p" ] || exit 3; [ -d "$p" ] && exit 4; readlink -f -- "$p"; stat -c '%s %Y' -- "$p"; head -c "$3" -- "$p""#,
        &[cwd, path, &limit.to_string()],
    );
    let out = conn.exec(&cmd, None).await?;
    if out.code != 0 {
        return Err(fail(out.code, path, &out.stderr));
    }
    let mut parts = out.stdout.splitn(3, |b| *b == b'\n');
    let abs = String::from_utf8_lossy(parts.next().unwrap_or_default()).into_owned();
    let meta = String::from_utf8_lossy(parts.next().unwrap_or_default()).into_owned();
    let data = parts.next().unwrap_or_default();
    let mut meta = meta.split_whitespace();
    let size: u64 = meta.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mtime: i64 = meta.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let truncated = size > data.len() as u64;
    let mut p = FilePreview { path: abs, size, mtime, kind: "binary", text: None, image: None, truncated };
    match mime {
        // 超过上限的图片没读全，当二进制
        Some(mime) if !truncated => {
            p.kind = "image";
            p.image = Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)));
        }
        None if !data[..data.len().min(8000)].contains(&0) => {
            p.kind = "text";
            p.text = Some(String::from_utf8_lossy(data).into_owned());
        }
        _ => {}
    }
    Ok(p)
}

/// 这些路径是不是存在的普通文件（正文里像路径的行内代码，确认存在才可点）
pub async fn exists(conn: &Arc<Conn>, cwd: &str, paths: &[String]) -> Result<Vec<bool>> {
    if paths.is_empty() {
        return Ok(vec![]);
    }
    let mut args = vec![cwd];
    args.extend(paths.iter().take(200).map(String::as_str));
    let out = conn.exec(&script(r#"shift; for p in "$@"; do [ -f "$(x "$p")" ] && echo 1 || echo 0; done"#, &args), None).await?;
    let mut v: Vec<bool> = String::from_utf8_lossy(&out.stdout).lines().map(|l| l == "1").collect();
    v.resize(paths.len(), false);
    Ok(v)
}

pub async fn download(conn: &Arc<Conn>, cwd: &str, path: &str, dest: &Path) -> Result<()> {
    let cmd = script(
        r#"p=$(x "$2"); [ -e "$p" ] || exit 3; [ -d "$p" ] && exit 4; s=$(stat -c %s -- "$p"); [ "$s" -le "$3" ] || { echo "$s"; exit 5; }; cat -- "$p""#,
        &[cwd, path, &DOWNLOAD_LIMIT.to_string()],
    );
    let out = conn.exec(&cmd, None).await?;
    if out.code == 5 {
        let size: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0);
        bail!("文件过大（{} MB），上限 {} MB", size >> 20, DOWNLOAD_LIMIT >> 20);
    }
    if out.code != 0 {
        return Err(fail(out.code, path, &out.stderr));
    }
    tokio::fs::write(dest, &out.stdout).await?;
    Ok(())
}
