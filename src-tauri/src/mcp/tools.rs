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
use crate::hosts::Host;
use super::tasks::Task;

const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const DEFAULT_READ_LINES: usize = 2000;
const MAX_OUTPUT_CHARS: usize = 30_000;
/// read_file 单次输出上限：只防极端文件（压缩 js、超长日志），别把普通文件切碎——多一轮就多读一遍整段上下文
const READ_BUDGET: usize = 50_000;
const MAX_LINE_CHARS: usize = 2000;
/// search_files 单次输出上限
const SEARCH_BUDGET: usize = 40_000;
const SEARCH_LINE_CHARS: usize = 300;
/// 结果不完整时提示里带的标记，审计据此记 capped
pub const CAPPED: &str = "【已截断】";

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
            "description": "读取文本文件，每行格式 行号<Tab>内容。自动识别 UTF-8（含 BOM）/ UTF-16LE / GBK，二进制文件会拒绝。单次输出约 50KB 封顶，超出会提示下一段的 offset；超过约 500 行的文件先用 search_files 定位再按 offset/limit 读。",
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
            "description": "精确字符串替换。old_string 必须在文件中唯一（或传 replace_all）；多处匹配会报出各处行号，找不到会给出最相似的行。保留文件原有编码和换行风格，修改前自动备份。",
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
            "description": "在目录下搜索文件（跳过 .gitignore 和隐藏文件），路径都相对于 path。glob 按文件名/相对路径过滤；regex 按内容匹配，content 模式按文件分组：先一行文件路径，下面是 行号: 内容（上下文行用 行号- ），长行围绕命中截取。结果不完整时末尾有【已截断】提示。",
            "inputSchema": { "type": "object", "required": ["path"], "properties": {
                "path": path,
                "glob": { "type": "string", "description": "如 **/*.java" },
                "regex": { "type": "string", "description": "内容正则" },
                "output_mode": { "type": "string", "enum": ["content", "files_with_matches", "count"], "description": "默认 content；只想知道哪些文件命中用 files_with_matches，看分布用 count" },
                "context": { "type": "integer", "description": "命中行前后各带几行上下文，默认 0，最大 10。要看命中附近的代码时用它，省掉再读文件" },
                "case_insensitive": { "type": "boolean" },
                "max_results": { "type": "integer", "description": "最多返回条数（content 按命中数，其余按文件数），默认 50" }
            } }
        },
        {
            "name": "run_command",
            "description": format!("{RUN_HINT}。受用户管控：可能未开启、只放行白名单，或需要用户在本机弹窗确认（会等待最多 60 秒）；\
一条命令只做一件事，不要用 & | > 等拼接，拼接的命令总是要确认。工作目录必须在允许的目录内。\
构建、跑测试等长任务请传 background=true，立即返回任务 id，再用 command_output 取输出。前台命令超时会结束整个进程树。"),
            "inputSchema": { "type": "object", "required": ["command"], "properties": {
                "command": { "type": "string" },
                "cwd": { "type": "string", "description": "工作目录，默认第一个允许的目录" },
                "timeout_secs": { "type": "integer", "description": "前台超时秒数，默认 120，最大 600" },
                "background": { "type": "boolean", "description": "后台运行，不受超时限制" },
                "include": { "type": "string", "description": "只保留匹配此正则的输出行" },
                "exclude": { "type": "string", "description": "去掉匹配此正则的输出行" },
                "tail_lines": { "type": "integer", "description": "只返回（过滤后的）最后 N 行" }
            } }
        },
        {
            "name": "command_output",
            "description": "取后台任务的输出和状态。传上次返回的 next_offset 只取新增部分；wait_secs 可等待新输出或任务结束（最多 50 秒）。构建/测试输出大时用 include/exclude/tail_lines 只取报错等关键行。不传 task_id 则列出所有任务。",
            "inputSchema": { "type": "object", "properties": {
                "task_id": { "type": "string" },
                "offset": { "type": "integer" },
                "wait_secs": { "type": "integer" },
                "until_done": { "type": "boolean", "description": "只在任务结束时返回（在 wait_secs 内）" },
                "include": { "type": "string", "description": "只保留匹配此正则的输出行" },
                "exclude": { "type": "string", "description": "去掉匹配此正则的输出行" },
                "tail_lines": { "type": "integer", "description": "只返回（过滤后的）最后 N 行" }
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

pub async fn call(st: &McpState, name: &str, args: &Value, host: Option<&Host>) -> Result<ToolOut> {
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
            let opts = SearchOpts {
                glob: args["glob"].as_str().map(str::to_string),
                regex: args["regex"].as_str().map(str::to_string),
                mode: args["output_mode"].as_str().unwrap_or("content").to_string(),
                context: args["context"].as_u64().unwrap_or(0).min(10) as usize,
                ignore_case: args["case_insensitive"].as_bool().unwrap_or(false),
                max: args["max_results"].as_u64().unwrap_or(50).max(1) as usize,
            };
            blocking(move || search_files(&dir, &opts)).await?
        }
        "run_command" => run_command(st, args, host).await?,
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
    ensure!(offset <= total.max(1), "offset {offset} 超出文件总行数 {total}");
    let mut out = String::new();
    let mut shown_end = offset - 1;
    let mut over_budget = false;
    for (i, line) in text.lines().enumerate().skip(offset - 1).take(limit) {
        if out.len() >= READ_BUDGET {
            over_budget = true;
            break;
        }
        let n = i + 1;
        if line.len() > MAX_LINE_CHARS && line.chars().count() > MAX_LINE_CHARS {
            let head: String = line.chars().take(MAX_LINE_CHARS).collect();
            let _ = writeln!(out, "{n}\t{head}…（本行共 {} 字符）", line.chars().count());
        } else {
            let _ = writeln!(out, "{n}\t{line}");
        }
        shown_end = n;
    }
    let note = enc.label().map(|l| format!("；文件编码 {l}")).unwrap_or_default();
    if over_budget {
        let _ = write!(
            out,
            "\n{CAPPED}输出达 {}KB 上限，已显示 {offset}-{shown_end} / 共 {total} 行，继续读传 offset={}{note}",
            READ_BUDGET / 1000,
            shown_end + 1
        );
    } else if shown_end < total {
        let _ = write!(out, "\n[共 {total} 行，已显示 {offset}-{shown_end}，继续读传 offset={}{note}]", shown_end + 1);
    } else if !note.is_empty() {
        let _ = write!(out, "\n[共 {total} 行{note}]");
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
    ensure!(count > 0, "未在文件中找到 old_string。{}", near_miss(&text, old));
    if !all && count > 1 {
        let lines: Vec<String> =
            text.match_indices(old).take(20).map(|(b, _)| (text[..b].matches('\n').count() + 1).to_string()).collect();
        bail!("old_string 出现了 {count} 次（第 {} 行），请带上更多上下文使其唯一，或传 replace_all", lines.join("、"));
    }
    let updated = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
    let updated = if crlf { updated.replace('\n', "\r\n") } else { updated };
    write_text(path, &updated, enc)?;
    Ok(format!("已修改 {}（替换 {} 处）", path.display(), if all { count } else { 1 }))
}

/// 找不到 old_string 时给线索：第一行非空内容只是空白不同，或文件里最长前缀匹配的行
fn near_miss(text: &str, old: &str) -> String {
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(first) = old.lines().map(str::trim).find(|l| !l.is_empty()) else { return String::new() };
    let target = norm(first);
    let lines: Vec<String> = text.lines().map(norm).collect();
    let same: Vec<String> =
        lines.iter().enumerate().filter(|(_, l)| **l == target).take(5).map(|(i, _)| (i + 1).to_string()).collect();
    if !same.is_empty() {
        return format!(
            "old_string 第一行在第 {} 行能对上（忽略空白），差别在缩进/制表符/行尾空格或后续行，请用 read_file 读这几行后照原文复制",
            same.join("、")
        );
    }
    let chars: Vec<char> = target.chars().collect();
    let mut n = chars.len();
    while n >= 8 {
        let prefix: String = chars[..n].iter().collect();
        if let Some(i) = lines.iter().position(|l| l.contains(&prefix)) {
            let line: String = text.lines().nth(i).unwrap_or("").trim().chars().take(200).collect();
            return format!("最相似的是第 {} 行（前 {n} 字符一致）：{line}", i + 1);
        }
        n = n * 2 / 3;
    }
    "文件里也没有相似的行，确认路径是否正确或文件是否已被改动".into()
}

struct SearchOpts {
    glob: Option<String>,
    regex: Option<String>,
    mode: String,
    context: usize,
    ignore_case: bool,
    max: usize,
}

fn search_files(dir: &Path, o: &SearchOpts) -> Result<String> {
    let glob = o.glob.as_deref().map(|g| globset::Glob::new(g).map(|g| g.compile_matcher())).transpose()?;
    let regex = o
        .regex
        .as_deref()
        .map(|r| regex::RegexBuilder::new(r).case_insensitive(o.ignore_case).build())
        .transpose()?;
    let mut out = String::new();
    let mut hits = 0;
    let mut capped = false;
    // 有下一条要输出时才判定触顶，刚好用满上限不算不完整
    let full = |hits: usize, out: &String| hits >= o.max || out.len() >= SEARCH_BUDGET;
    'walk: for entry in ignore::WalkBuilder::new(dir).build().flatten() {
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
        let rel = rel.display();
        let Some(re) = &regex else {
            if full(hits, &out) {
                capped = true;
                break;
            }
            let _ = writeln!(out, "{rel}");
            hits += 1;
            continue;
        };
        // 跳过大文件；二进制文件 read_text 会报错，直接跳过
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > 2 * 1024 * 1024 {
            continue;
        }
        let Ok((text, _)) = read_text(path) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let matched: Vec<usize> = (0..lines.len()).filter(|&i| re.is_match(lines[i])).collect();
        if matched.is_empty() {
            continue;
        }
        if full(hits, &out) {
            capped = true;
            break;
        }
        match o.mode.as_str() {
            "files_with_matches" => {
                let _ = writeln!(out, "{rel}");
                hits += 1;
            }
            "count" => {
                let _ = writeln!(out, "{rel}: {}", matched.len());
                hits += 1;
            }
            _ => {
                let _ = writeln!(out, "{rel}");
                let mut printed: Option<usize> = None;
                for &m in &matched {
                    if full(hits, &out) {
                        capped = true;
                        break 'walk;
                    }
                    let start = m.saturating_sub(o.context);
                    let end = (m + o.context).min(lines.len() - 1);
                    let from = match printed {
                        Some(p) if p + 1 >= start => p + 1,
                        Some(_) => {
                            out.push_str("--\n");
                            start
                        }
                        None => start,
                    };
                    for i in from..=end {
                        let sep = if matched.binary_search(&i).is_ok() { ':' } else { '-' };
                        let line = if o.context == 0 { lines[i].trim() } else { lines[i].trim_end() };
                        let _ = writeln!(out, "{}{sep} {}", i + 1, clip_around(line, re));
                    }
                    printed = Some(printed.map_or(end, |p| p.max(end)));
                    hits += 1;
                }
            }
        }
    }
    if out.is_empty() {
        out.push_str("（无匹配）");
    } else if capped {
        let _ = write!(
            out,
            "{CAPPED}已达上限（{} 条或 {}KB），结果不完整。可缩小 path/glob、改用 output_mode=files_with_matches/count 看全貌，或加大 max_results",
            o.max,
            SEARCH_BUDGET / 1000
        );
    }
    Ok(out)
}

/// 长行只保留命中位置附近的一段（前 100 字符起），避免取行首时把关键词截掉
fn clip_around(line: &str, re: &regex::Regex) -> String {
    let total = line.chars().count();
    if total <= SEARCH_LINE_CHARS {
        return line.to_string();
    }
    let hit = re.find(line).map(|m| line[..m.start()].chars().count()).unwrap_or(0);
    let start = hit.saturating_sub(100).min(total - SEARCH_LINE_CHARS);
    let body: String = line.chars().skip(start).take(SEARCH_LINE_CHARS).collect();
    let head = if start > 0 { "…" } else { "" };
    let tail = if start + SEARCH_LINE_CHARS < total { "…" } else { "" };
    format!("{head}{body}{tail}（本行共 {total} 字符）")
}

/// host：发起的主机，用它单独设的管控模式；没设或本机其他程序直连时用全局模式
async fn run_command(st: &McpState, args: &Value, host: Option<&Host>) -> Result<String> {
    let command = str_arg(args, "command")?;
    let cwd = match args["cwd"].as_str() {
        Some(c) => st.guard.check(c)?,
        None => st.guard.roots().into_iter().next().context("未配置允许的目录")?,
    };
    let filter = OutFilter::from_args(args)?;
    let (global, allowlist) = {
        let s = st.guard.settings.read().unwrap();
        (s.command_mode, s.command_allowlist.clone())
    };
    let mode = host.and_then(|h| h.command_mode).unwrap_or(global);
    let who = host.map_or("本机程序", |h| h.name.as_str());
    let cwd_text = cwd.to_string_lossy();
    if let Some(rule) = st.approvals.check(&st.app, mode, &allowlist, who, command, &cwd_text).await? {
        add_rule(st, &rule)?;
    }
    let task = st.tasks.spawn(command, &cwd)?;
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
        bail!("命令超时（{timeout} 秒），已结束整个进程树。长任务请用 background=true。已产生的输出：\n{}", filter.apply(&chunk.text));
    }
    let chunk = task.read_from(0);
    Ok(format!("退出码：{}\n{}", exit_text(chunk.exit), filter.apply(&chunk.text)))
}

/// 确认弹窗里选了「总是允许」：规则加进白名单并保存
fn add_rule(st: &McpState, rule: &str) -> Result<()> {
    let rule = rule.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut s = st.guard.settings.write().unwrap();
    if !rule.is_empty() && !s.command_allowlist.contains(&rule) {
        s.command_allowlist.push(rule);
        s.save(&st.settings_path)?;
    }
    Ok(())
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
    let filter = OutFilter::from_args(args)?;
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let wait = args["wait_secs"].as_u64().unwrap_or(0).min(50);
    task.wait(offset, Duration::from_secs(wait), args["until_done"].as_bool().unwrap_or(false)).await;
    let chunk = task.read_from(offset);
    let state = match chunk.exit {
        None => format!("运行中（已 {} 秒）", task.elapsed_secs()),
        Some(code) => format!("已结束，退出码 {}", exit_text(Some(code))),
    };
    let skipped = if chunk.skipped { "（最早的输出已超出缓存被丢弃）\n" } else { "" };
    Ok(format!("状态：{state}\nnext_offset：{}\n{skipped}{}", chunk.next_offset, filter.apply(&chunk.text)))
}

/// 命令输出的服务端过滤：正则包含/排除、只取最后 N 行；被去掉的行只报数量
struct OutFilter {
    include: Option<regex::Regex>,
    exclude: Option<regex::Regex>,
    tail_lines: Option<usize>,
}

impl OutFilter {
    fn from_args(args: &Value) -> Result<Self> {
        let re = |key: &str| args[key].as_str().map(regex::Regex::new).transpose().with_context(|| format!("{key} 不是合法正则"));
        Ok(Self { include: re("include")?, exclude: re("exclude")?, tail_lines: args["tail_lines"].as_u64().map(|n| n as usize) })
    }

    fn apply(&self, text: &str) -> String {
        if self.include.is_none() && self.exclude.is_none() && self.tail_lines.is_none() {
            return tail(text);
        }
        let total = text.lines().count();
        let mut kept: Vec<&str> = text
            .lines()
            .filter(|l| self.include.as_ref().is_none_or(|r| r.is_match(l)))
            .filter(|l| !self.exclude.as_ref().is_some_and(|r| r.is_match(l)))
            .collect();
        let filtered = total - kept.len();
        let mut omitted = 0;
        if let Some(n) = self.tail_lines.filter(|&n| kept.len() > n) {
            omitted = kept.len() - n;
            kept.drain(..omitted);
        }
        let mut note = String::new();
        if filtered > 0 {
            let _ = write!(note, "过滤掉 {filtered} 行");
        }
        if omitted > 0 {
            let _ = write!(note, "{}省略前 {omitted} 行", if note.is_empty() { "" } else { "，" });
        }
        let body = kept.join("\n");
        tail(&if note.is_empty() { body } else { format!("（共 {total} 行，{note}）\n{body}") })
    }
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
    format!("{CAPPED}输出共 {chars} 字符，仅保留末尾 {MAX_OUTPUT_CHARS}（可用 include/exclude/tail_lines 只取需要的行）\n…{tail}")
}
