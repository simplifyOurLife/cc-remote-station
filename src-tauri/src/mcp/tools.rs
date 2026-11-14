use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde_json::{Value, json};
use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use super::McpState;
use super::guard::describe;
use super::tasks::Task;

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_READ_LINES: usize = 2000;
const MAX_OUTPUT_CHARS: usize = 30_000;

/// 工具返回：绝大多数是文本，view_image 返回图片
pub enum ToolOut {
    Text(String),
    Image { data: String, mime: &'static str },
}

#[cfg(windows)]
const PATH_HINT: &str = "Windows 绝对路径，如 D:\\project\\src\\main.rs";
#[cfg(not(windows))]
const PATH_HINT: &str = "本机绝对路径，如 /Users/me/project/src/main.rs";
#[cfg(windows)]
const RUN_HINT: &str = "在本机 Windows 上用 cmd 执行命令";
#[cfg(not(windows))]
const RUN_HINT: &str = "在本机 Mac 上用用户的登录 shell（一般是 zsh）执行命令";

/// tools/list 返回的工具定义。run_command 始终列出，关闭时调用会返回明确提示
///（Claude Code 只在连接时拉一次工具列表，按开关动态增减反而会让它看不到）
pub fn list() -> Value {
    let path = json!({ "type": "string", "description": PATH_HINT });
    json!([
        {
            "name": "list_allowed_roots",
            "description": "列出允许访问的本机目录。先调用它了解能操作哪些路径。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_directory",
            "description": "列出目录内容（目录以 / 结尾，文件带字节数）。",
            "inputSchema": { "type": "object", "required": ["path"], "properties": {
                "path": path,
                "depth": { "type": "integer", "description": "递归深度，默认 1，最大 3" }
            } }
        },
        {
            "name": "read_file",
            "description": "读取文本文件，输出带行号。自动识别 UTF-8（含 BOM）/ UTF-16LE / GBK，二进制文件会拒绝。大文件用 offset/limit 分段读。",
            "inputSchema": { "type": "object", "required": ["path"], "properties": {
                "path": path,
                "offset": { "type": "integer", "description": "起始行号（1 开始）" },
                "limit": { "type": "integer", "description": "最多读取行数，默认 2000" }
            } }
        },
        {
            "name": "view_image",
            "description": "以图片形式查看本机图片（png / jpg / gif / webp，不超过 5MB），用于看截图、设计稿。",
            "inputSchema": { "type": "object", "required": ["path"], "properties": { "path": path } }
        },
        {
            "name": "write_file",
            "description": "创建或整体覆盖文件（自动创建父目录，覆盖前自动备份，保留已有文件的编码）。局部修改请用 edit_file。",
            "inputSchema": { "type": "object", "required": ["path", "content"], "properties": {
                "path": path,
                "content": { "type": "string" }
            } }
        },
        {
            "name": "edit_file",
            "description": "精确字符串替换。old_string 必须在文件中唯一（或传 replace_all）。保留文件原有编码和换行风格，修改前自动备份。",
            "inputSchema": { "type": "object", "required": ["path", "old_string", "new_string"], "properties": {
                "path": path,
                "old_string": { "type": "string" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean" }
            } }
        },
        {
            "name": "delete_file",
            "description": "删除单个文件（删除前自动备份，可在 cc-workstation 里恢复）。不支持删除目录。",
            "inputSchema": { "type": "object", "required": ["path"], "properties": { "path": path } }
        },
        {
            "name": "move_file",
            "description": "移动或重命名文件/目录，源和目标都须在允许的目录内。目标已存在时需传 overwrite（仅限文件，覆盖前备份）。",
            "inputSchema": { "type": "object", "required": ["from", "to"], "properties": {
                "from": { "type": "string" },
                "to": { "type": "string" },
                "overwrite": { "type": "boolean" }
            } }
        },
        {
            "name": "create_directory",
            "description": "创建目录（含缺失的上级目录）。",
            "inputSchema": { "type": "object", "required": ["path"], "properties": { "path": path } }
        },
        {
            "name": "search_files",
            "description": "在目录下搜索文件（跳过 .gitignore 和隐藏文件）。glob 按文件名/相对路径过滤，regex 按内容匹配并返回 路径:行号: 内容。",
            "inputSchema": { "type": "object", "required": ["path"], "properties": {
                "path": path,
                "glob": { "type": "string", "description": "如 **/*.java" },
                "regex": { "type": "string", "description": "内容正则" },
                "max_results": { "type": "integer", "description": "默认 200" }
            } }
        },
        {
            "name": "run_command",
            "description": format!("{RUN_HINT}（需用户在 cc-workstation 中开启）。工作目录必须在允许的目录内。\
构建、跑测试等长任务请传 background=true，立即返回任务 id，再用 command_output 取输出。前台命令超时会结束整个进程树。"),
            "inputSchema": { "type": "object", "required": ["command"], "properties": {
                "command": { "type": "string" },
                "cwd": { "type": "string", "description": "工作目录，默认第一个允许的目录" },
                "timeout_secs": { "type": "integer", "description": "前台超时秒数，默认 120，最大 600" },
                "background": { "type": "boolean", "description": "后台运行，不受超时限制" }
            } }
        },
        {
            "name": "command_output",
            "description": "取后台任务的输出和状态。传上次返回的 next_offset 只取新增部分；wait_secs 可等待新输出或任务结束（最多 50 秒）。不传 task_id 则列出所有任务。",
            "inputSchema": { "type": "object", "properties": {
                "task_id": { "type": "string" },
                "offset": { "type": "integer" },
                "wait_secs": { "type": "integer" },
                "until_done": { "type": "boolean", "description": "只在任务结束时返回（在 wait_secs 内）" }
            } }
        },
        {
            "name": "stop_command",
            "description": "停止后台任务（结束整个进程树）。",
            "inputSchema": { "type": "object", "required": ["task_id"], "properties": { "task_id": { "type": "string" } } }
        },
        {
            "name": "clipboard_read",
            "description": "读取本机剪贴板中的文本。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "clipboard_write",
            "description": "把文本写入本机剪贴板。",
            "inputSchema": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" } } }
        },
        {
            "name": "notify",
            "description": "在本机弹出桌面通知，用于长任务完成后提醒用户。",
            "inputSchema": { "type": "object", "required": ["body"], "properties": {
                "title": { "type": "string" },
                "body": { "type": "string" }
            } }
        },
        {
            "name": "open",
            "description": "用本机默认程序打开文件（须在允许的目录内）或 http(s) 网址。",
            "inputSchema": { "type": "object", "required": ["target"], "properties": { "target": { "type": "string" } } }
        }
    ])
}

pub async fn call(st: &McpState, name: &str, args: &Value) -> Result<ToolOut> {
    let text = match name {
        "list_allowed_roots" => describe(&st.guard.roots()),
        "list_directory" => {
            let dir = st.guard.check(str_arg(args, "path")?)?;
            let depth = args["depth"].as_u64().unwrap_or(1).clamp(1, 3) as usize;
            blocking(move || list_directory(&dir, depth)).await?
        }
        "read_file" => {
            let path = st.guard.check(str_arg(args, "path")?)?;
            let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
            let limit = args["limit"].as_u64().map(|n| n as usize).unwrap_or(DEFAULT_READ_LINES);
            blocking(move || read_file(&path, offset, limit)).await?
        }
        "view_image" => {
            let path = st.guard.check(str_arg(args, "path")?)?;
            return view_image(&path);
        }
        "write_file" => {
            let path = st.guard.check(str_arg(args, "path")?)?;
            let content = str_arg(args, "content")?.to_string();
            st.guard.backup(&path, name)?;
            blocking(move || {
                // 覆盖已有文件时沿用其编码，新文件一律 UTF-8
                let enc = if path.is_file() { read_text(&path)?.1 } else { TextEnc::Utf8 };
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                write_text(&path, &content, enc)?;
                Ok(format!("已写入 {}（{} 行）", path.display(), content.lines().count()))
            })
            .await?
        }
        "edit_file" => {
            let path = st.guard.check(str_arg(args, "path")?)?;
            let old = str_arg(args, "old_string")?.to_string();
            let new = str_arg(args, "new_string")?.to_string();
            let all = args["replace_all"].as_bool().unwrap_or(false);
            st.guard.backup(&path, name)?;
            blocking(move || edit_file(&path, &old, &new, all)).await?
        }
        "delete_file" => {
            let path = st.guard.check(str_arg(args, "path")?)?;
            ensure!(path.is_file(), "不是文件或不存在：{}（不支持删除目录）", path.display());
            st.guard.backup(&path, name)?;
            std::fs::remove_file(&path)?;
            format!("已删除 {}（已备份）", path.display())
        }
        "move_file" => {
            let from = st.guard.check(str_arg(args, "from")?)?;
            let to = st.guard.check(str_arg(args, "to")?)?;
            ensure!(from.exists(), "源不存在：{}", from.display());
            if to.exists() {
                ensure!(args["overwrite"].as_bool().unwrap_or(false), "目标已存在：{}（覆盖请传 overwrite）", to.display());
                ensure!(to.is_file() && from.is_file(), "只能用文件覆盖文件");
                st.guard.backup(&to, name)?;
            }
            if let Some(dir) = to.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::rename(&from, &to)?;
            format!("已移动 {} → {}", from.display(), to.display())
        }
        "create_directory" => {
            let path = st.guard.check(str_arg(args, "path")?)?;
            std::fs::create_dir_all(&path)?;
            format!("已创建目录 {}", path.display())
        }
        "search_files" => {
            let dir = st.guard.check(str_arg(args, "path")?)?;
            let glob = args["glob"].as_str().map(str::to_string);
            let regex = args["regex"].as_str().map(str::to_string);
            let max = args["max_results"].as_u64().unwrap_or(200) as usize;
            blocking(move || search_files(&dir, glob.as_deref(), regex.as_deref(), max)).await?
        }
        "run_command" => run_command(st, args).await?,
        "command_output" => command_output(st, args).await?,
        "stop_command" => {
            let task = st.tasks.get(str_arg(args, "task_id")?).context("任务不存在")?;
            task.kill();
            task.wait(0, Duration::from_secs(5), true).await;
            format!("已停止任务 {}", task.id)
        }
        "clipboard_read" => st.app.clipboard().read_text()?,
        "clipboard_write" => {
            st.app.clipboard().write_text(str_arg(args, "text")?)?;
            "已写入剪贴板".into()
        }
        "notify" => {
            let title = args["title"].as_str().unwrap_or("Claude Code");
            st.app.notification().builder().title(title).body(str_arg(args, "body")?).show()?;
            "已发送通知".into()
        }
        "open" => {
            let target = str_arg(args, "target")?;
            if target.starts_with("http://") || target.starts_with("https://") {
                st.app.opener().open_url(target, None::<&str>)?;
            } else {
                let path = st.guard.check(target)?;
                st.app.opener().open_path(path.to_string_lossy(), None::<&str>)?;
            }
            format!("已打开 {target}")
        }
        _ => bail!("未知工具：{name}"),
    };
    Ok(ToolOut::Text(text))
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().with_context(|| format!("缺少参数 {key}"))
}

/// 文件系统操作放到阻塞线程池，避免卡住 HTTP 服务
async fn blocking<F: FnOnce() -> Result<String> + Send + 'static>(f: F) -> Result<String> {
    tokio::task::spawn_blocking(f).await?
}

#[derive(Clone, Copy, PartialEq)]
enum TextEnc {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Gbk,
}

impl TextEnc {
    fn label(self) -> Option<&'static str> {
        match self {
            TextEnc::Utf8 => None,
            TextEnc::Utf8Bom => Some("UTF-8 BOM"),
            TextEnc::Utf16Le => Some("UTF-16LE"),
            TextEnc::Gbk => Some("GBK"),
        }
    }
}

/// 识别编码并解码。BOM 不进入文本（否则第一行开头多一个不可见字符，匹配会失败），写回时再补上。
/// 前 8KB 内有 NUL 字节且不是 UTF-16 的视为二进制，拒绝按文本读。
fn read_text(path: &Path) -> Result<(String, TextEnc)> {
    let size = std::fs::metadata(path)?.len();
    ensure!(size <= MAX_FILE_BYTES, "文件过大（{size} 字节），上限 {MAX_FILE_BYTES}");
    let bytes = std::fs::read(path)?;
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return Ok((String::from_utf8_lossy(rest).into_owned(), TextEnc::Utf8Bom));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let (text, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(rest);
        return Ok((text.into_owned(), TextEnc::Utf16Le));
    }
    ensure!(
        !bytes[..bytes.len().min(8192)].contains(&0),
        "这是二进制文件，不能按文本读取（图片可用 view_image）：{}",
        path.display()
    );
    match String::from_utf8(bytes) {
        Ok(s) => Ok((s, TextEnc::Utf8)),
        Err(e) => Ok((encoding_rs::GB18030.decode(e.as_bytes()).0.into_owned(), TextEnc::Gbk)),
    }
}

fn write_text(path: &Path, text: &str, enc: TextEnc) -> Result<()> {
    let bytes: Vec<u8> = match enc {
        TextEnc::Utf8 => text.as_bytes().to_vec(),
        TextEnc::Utf8Bom => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
        TextEnc::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        TextEnc::Gbk => encoding_rs::GB18030.encode(text).0.into_owned(),
    };
    std::fs::write(path, bytes)?;
    Ok(())
}

fn view_image(path: &Path) -> Result<ToolOut> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => bail!("只支持 png / jpg / gif / webp：{}", path.display()),
    };
    let size = std::fs::metadata(path)?.len();
    ensure!(size <= MAX_IMAGE_BYTES, "图片过大（{size} 字节），上限 5MB");
    let data = base64::engine::general_purpose::STANDARD.encode(std::fs::read(path)?);
    Ok(ToolOut::Image { data, mime })
}

fn list_directory(dir: &Path, depth: usize) -> Result<String> {
    let mut out = String::new();
    let mut count = 0;
    walk(dir, dir, depth, &mut out, &mut count)?;
    if out.is_empty() {
        out.push_str("（空目录）");
    }
    Ok(out)
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut String, count: &mut usize) -> Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.flatten().collect();
    entries.sort_by_key(|e| (!e.path().is_dir(), e.file_name()));
    for entry in entries {
        if *count >= 1000 {
            out.push_str("……（超过 1000 项，已截断）\n");
            return Ok(());
        }
        *count += 1;
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(&path).display();
        if path.is_dir() {
            let _ = writeln!(out, "{rel}/");
            if depth > 1 {
                walk(root, &path, depth - 1, out, count)?;
            }
        } else {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let _ = writeln!(out, "{rel}  {size}");
        }
    }
    Ok(())
}

fn read_file(path: &Path, offset: usize, limit: usize) -> Result<String> {
    let (text, enc) = read_text(path)?;
    let total = text.lines().count();
    let mut out = String::new();
    for (i, line) in text.lines().enumerate().skip(offset - 1).take(limit) {
        let _ = writeln!(out, "{:>6}\t{line}", i + 1);
    }
    let shown_end = (offset - 1 + limit).min(total);
    if enc.label().is_some() || shown_end < total {
        let note = enc.label().map(|l| format!("；文件编码 {l}")).unwrap_or_default();
        let _ = write!(out, "\n[共 {total} 行，已显示 {offset}-{shown_end}{note}]");
    }
    Ok(out)
}

fn edit_file(path: &Path, old: &str, new: &str, all: bool) -> Result<String> {
    ensure!(!old.is_empty(), "old_string 不能为空");
    let (text, enc) = read_text(path)?;
    // Claude 传来的片段是 LF，文件是 CRLF 时统一成 LF 匹配，写回时还原
    let crlf = text.contains("\r\n");
    let text = if crlf { text.replace("\r\n", "\n") } else { text };
    let count = text.matches(old).count();
    ensure!(count > 0, "未在文件中找到 old_string");
    ensure!(all || count == 1, "old_string 出现了 {count} 次，请带上更多上下文使其唯一，或传 replace_all");
    let updated = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
    let updated = if crlf { updated.replace('\n', "\r\n") } else { updated };
    write_text(path, &updated, enc)?;
    Ok(format!("已修改 {}（替换 {} 处）", path.display(), if all { count } else { 1 }))
}

fn search_files(dir: &Path, glob: Option<&str>, regex: Option<&str>, max: usize) -> Result<String> {
    let glob = glob.map(|g| globset::Glob::new(g).map(|g| g.compile_matcher())).transpose()?;
    let regex = regex.map(regex::Regex::new).transpose()?;
    let mut out = String::new();
    let mut hits = 0;
    for entry in ignore::WalkBuilder::new(dir).build().flatten() {
        if hits >= max {
            let _ = write!(out, "……（已达上限 {max} 条）");
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let rel = path.strip_prefix(dir).unwrap_or(path);
        if let Some(g) = &glob {
            let name_match = path.file_name().is_some_and(|n| g.is_match(n));
            if !name_match && !g.is_match(rel) {
                continue;
            }
        }
        let Some(re) = &regex else {
            let _ = writeln!(out, "{}", path.display());
            hits += 1;
            continue;
        };
        // 跳过大文件；二进制文件 read_text 会报错，直接跳过
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > 2 * 1024 * 1024 {
            continue;
        }
        let Ok((text, _)) = read_text(path) else { continue };
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                let line: String = line.trim().chars().take(300).collect();
                let _ = writeln!(out, "{}:{}: {line}", path.display(), i + 1);
                hits += 1;
                if hits >= max {
                    break;
                }
            }
        }
    }
    if out.is_empty() {
        out.push_str("（无匹配）");
    }
    Ok(out)
}

async fn run_command(st: &McpState, args: &Value) -> Result<String> {
    ensure!(
        st.guard.settings.read().unwrap().allow_commands,
        "用户未开启本机命令执行。请提示用户在 cc-workstation 「本机访问设置」里打开「允许执行命令」。"
    );
    let cwd = match args["cwd"].as_str() {
        Some(c) => st.guard.check(c)?,
        None => st.guard.roots().into_iter().next().context("未配置允许的目录")?,
    };
    let task = st.tasks.spawn(str_arg(args, "command")?, &cwd)?;
    if args["background"].as_bool().unwrap_or(false) {
        return Ok(format!(
            "已在后台启动，任务 id：{}。用 command_output（task_id={}）取输出，stop_command 停止。",
            task.id, task.id
        ));
    }
    let timeout = args["timeout_secs"].as_u64().unwrap_or(120).clamp(1, 600);
    task.wait(0, Duration::from_secs(timeout), true).await;
    if !task.is_done() {
        task.kill();
        task.wait(0, Duration::from_secs(5), true).await;
        let chunk = task.read_from(0);
        bail!("命令超时（{timeout} 秒），已结束整个进程树。长任务请用 background=true。已产生的输出：\n{}", tail(&chunk.text));
    }
    let chunk = task.read_from(0);
    Ok(format!("退出码：{}\n{}", exit_text(chunk.exit), tail(&chunk.text)))
}

async fn command_output(st: &McpState, args: &Value) -> Result<String> {
    let Some(id) = args["task_id"].as_str() else {
        let mut out = String::new();
        for t in st.tasks.list() {
            let state = if t.is_done() { exit_text(t.read_from(usize::MAX).exit) } else { "运行中".into() };
            let _ = writeln!(out, "{}  [{state}]  {}s  {}", t.id, t.elapsed_secs(), t.command);
        }
        return Ok(if out.is_empty() { "（没有任务）".into() } else { out });
    };
    let task: std::sync::Arc<Task> = st.tasks.get(id).context("任务不存在（可能已被清理）")?;
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let wait = args["wait_secs"].as_u64().unwrap_or(0).min(50);
    task.wait(offset, Duration::from_secs(wait), args["until_done"].as_bool().unwrap_or(false)).await;
    let chunk = task.read_from(offset);
    let state = match chunk.exit {
        None => format!("运行中（已 {} 秒）", task.elapsed_secs()),
        Some(code) => format!("已结束，退出码 {}", exit_text(Some(code))),
    };
    let skipped = if chunk.skipped { "（最早的输出已超出缓存被丢弃）\n" } else { "" };
    Ok(format!("状态：{state}\nnext_offset：{}\n{skipped}{}", chunk.next_offset, tail(&chunk.text)))
}

fn exit_text(exit: Option<Option<i32>>) -> String {
    match exit {
        None => "运行中".into(),
        Some(None) => "无（被结束）".into(),
        Some(Some(c)) => c.to_string(),
    }
}

/// 输出太长只保留尾部（报错通常在最后）
fn tail(text: &str) -> String {
    let chars = text.chars().count();
    if chars <= MAX_OUTPUT_CHARS {
        return text.to_string();
    }
    let tail: String = text.chars().skip(chars - MAX_OUTPUT_CHARS).collect();
    format!("（输出共 {chars} 字符，仅保留末尾 {MAX_OUTPUT_CHARS}）\n…{tail}")
}
