//! 从本机已有的 MCP 配置里找可以导入工具箱的条目：Claude Code（~/.claude.json 的全局和各项目）、
//! Claude Desktop、Cursor。三者都是 { "mcpServers": { 名字: { command/args/env | url/headers } } } 格式。
//! 只读不写；解析不了的条目连同原因一起返回，前端展示为「跳过」。

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::settings::{KeyValue, Source};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    /// 来自哪里，如「Claude Code · 全局」「Claude Code · D:\proj」「Cursor」
    pub origin: String,
    /// 配置里的原名
    pub name: String,
    /// 解析出的来源；解析不了时为 None，原因在 skipped
    pub source: Option<Source>,
    pub skipped: Option<String>,
}

pub fn scan() -> Vec<ImportCandidate> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        if let Some(root) = read_json(&home.join(".claude.json")) {
            collect(&mut out, "Claude Code · 全局", root.get("mcpServers"));
            if let Some(projects) = root.get("projects").and_then(Value::as_object) {
                for (dir, p) in projects {
                    collect(&mut out, &format!("Claude Code · {dir}"), p.get("mcpServers"));
                }
            }
        }
        if let Some(root) = read_json(&home.join(".cursor").join("mcp.json")) {
            collect(&mut out, "Cursor", root.get("mcpServers"));
        }
    }
    if let Some(root) = desktop_config().and_then(|p| read_json(&p)) {
        collect(&mut out, "Claude Desktop", root.get("mcpServers"));
    }
    out
}

fn desktop_config() -> Option<PathBuf> {
    // Windows: %APPDATA%\Claude；macOS: ~/Library/Application Support/Claude
    dirs::config_dir().map(|d| d.join("Claude").join("claude_desktop_config.json"))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn collect(out: &mut Vec<ImportCandidate>, origin: &str, servers: Option<&Value>) {
    let Some(servers) = servers.and_then(Value::as_object) else { return };
    for (name, def) in servers {
        let (source, skipped) = match parse(def) {
            Ok(s) => (Some(s), None),
            Err(why) => (None, Some(why)),
        };
        out.push(ImportCandidate { origin: origin.into(), name: name.clone(), source, skipped });
    }
}

fn parse(def: &Value) -> Result<Source, String> {
    let def = def.as_object().ok_or("配置不是对象")?;
    let kind = def.get("type").and_then(Value::as_str).unwrap_or("");
    if let Some(command) = def.get("command").and_then(Value::as_str) {
        let args = def
            .get("args")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(text).collect())
            .unwrap_or_default();
        let cwd = def.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
        return Ok(Source::Stdio { command: command.into(), args, env: pairs(def.get("env")), cwd });
    }
    if let Some(url) = def.get("url").and_then(Value::as_str) {
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(format!("不支持的地址 {url}"));
        }
        return Ok(Source::Http { url: url.into(), headers: pairs(def.get("headers")), legacy_sse: kind == "sse" });
    }
    Err(if kind.is_empty() { "没有 command 或 url".into() } else { format!("不支持的类型 {kind}") })
}

fn text(v: &Value) -> String {
    v.as_str().map(String::from).unwrap_or_else(|| v.to_string())
}

fn pairs(v: Option<&Value>) -> Vec<KeyValue> {
    v.and_then(Value::as_object)
        .map(|m: &Map<String, Value>| m.iter().map(|(k, v)| KeyValue { key: k.clone(), value: text(v) }).collect())
        .unwrap_or_default()
}
