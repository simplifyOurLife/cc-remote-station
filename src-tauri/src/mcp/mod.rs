//! 内置 MCP 服务：只监听 127.0.0.1，经 SSH 反向转发给云端 Claude Code 使用。
//! 实现 Streamable HTTP 传输的最小子集：POST /mcp 收单条 JSON-RPC，直接返回 JSON（不开 SSE 流）。

mod guard;
mod tasks;
mod tools;

use anyhow::Result;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header::AUTHORIZATION};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};

pub use guard::{BackupEntry, Guard};
use tasks::Tasks;
use tools::ToolOut;

const INSTRUCTIONS: &str = "这些工具操作的是用户本地的 Windows 电脑（经 cc-workstation 的 SSH 隧道提供），不是当前这台云主机。\
路径一律用 Windows 绝对路径；先调用 list_allowed_roots 查看允许访问的目录。写入、修改、删除前会自动备份。\
构建、测试等长命令用 run_command 的 background=true，再用 command_output 取输出。";

pub struct McpState {
    guard: Arc<Guard>,
    tasks: Tasks,
    app: AppHandle,
}

/// 启动服务，返回本机监听端口（系统分配的随机端口，只给 SSH 反向转发用）
pub async fn serve(app: AppHandle, guard: Arc<Guard>) -> Result<u16> {
    let state = Arc::new(McpState { guard, tasks: Tasks::default(), app });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let router = Router::new()
        .route("/mcp", post(handle).get(|| async { StatusCode::METHOD_NOT_ALLOWED }))
        .with_state(state);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            log::error!("MCP 服务退出: {e}");
        }
    });
    Ok(port)
}

async fn handle(State(st): State<Arc<McpState>>, headers: HeaderMap, Json(req): Json<Value>) -> Response {
    let expected = format!("Bearer {}", st.guard.settings.read().unwrap().token);
    if headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // 没有 id 的是通知（如 notifications/initialized），按协议回 202 且无内容
    let Some(id) = req.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match req["method"].as_str().unwrap_or("") {
        "initialize" => Ok(json!({
            "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "cc-workstation", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::list() })),
        "tools/call" => Ok(call_tool(&st, &params).await),
        other => Err(json!({ "code": -32601, "message": format!("未知方法：{other}") })),
    };
    let body = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    };
    Json(body).into_response()
}

/// 执行工具、写审计并通知前端；工具失败按 MCP 约定放在 isError 里返回，让 Claude 看到原因
async fn call_tool(st: &McpState, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let started = Instant::now();
    let result = tools::call(st, name, &args).await;
    let entry = json!({
        "ts": chrono::Local::now().to_rfc3339(),
        "tool": name,
        "args": abbreviate(&args),
        "ok": result.is_ok(),
        "error": result.as_ref().err().map(|e| format!("{e:#}")),
        "ms": started.elapsed().as_millis() as u64,
    });
    st.guard.audit(&entry);
    let _ = st.app.emit("mcp-activity", &entry);
    match result {
        Ok(ToolOut::Text(text)) => json!({ "content": [{ "type": "text", "text": text }] }),
        Ok(ToolOut::Image { data, mime }) => json!({ "content": [{ "type": "image", "data": data, "mimeType": mime }] }),
        Err(e) => json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true }),
    }
}

/// 审计里只记大字段的开头，避免日志被文件内容撑爆
fn abbreviate(args: &Value) -> Value {
    let mut args = args.clone();
    if let Some(map) = args.as_object_mut() {
        for v in map.values_mut() {
            let short = v.as_str().filter(|s| s.chars().count() > 200).map(|s| {
                format!("{}…（共 {} 字符）", s.chars().take(200).collect::<String>(), s.chars().count())
            });
            if let Some(short) = short {
                *v = json!(short);
            }
        }
    }
    args
}
