//! 云端执行本机命令（run_command）的管控：按发起请求的主机取模式（主机单独设的优先，否则全局），
//! 白名单直接放行，其余在本机弹窗确认，没人处理就到时自动拒绝。

use anyhow::{Result, bail};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::oneshot;

use crate::settings::CommandMode;

const CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);

/// 用户在确认弹窗里的选择
pub enum Decision {
    Once,
    /// 允许并把这条规则加进白名单
    Always(String),
    Deny,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmRequest {
    id: String,
    /// 发起的主机名
    host_name: String,
    command: String,
    cwd: String,
    /// 为什么要确认
    reason: String,
    /// 可以加进白名单的规则；None 表示不提供「总是允许」
    rule: Option<String>,
    timeout_secs: u64,
}

#[derive(Default)]
pub struct Approvals {
    pending: Mutex<HashMap<String, oneshot::Sender<Decision>>>,
    /// 命令执行关闭时上次提醒用户的时间（按主机名），避免连续被拒时反复弹通知
    off_notified: Mutex<HashMap<String, Instant>>,
}

/// 同一台主机「命令执行已关闭」的提醒间隔
const OFF_NOTIFY_EVERY: Duration = Duration::from_secs(600);

impl Approvals {
    /// 弹窗问用户，等到回答或超时；超时、窗口没响应都算拒绝
    async fn ask(&self, app: &AppHandle, req: ConfirmRequest) -> Decision {
        let (tx, rx) = oneshot::channel();
        let id = req.id.clone();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let _ = app.emit("command-confirm", &req);
        // 窗口可能在托盘里，桌面通知提醒一下
        let _ = app
            .notification()
            .builder()
            .title(format!("{} 请求在本机执行命令", req.host_name))
            .body(&req.command)
            .show();
        let answer = tokio::time::timeout(CONFIRM_TIMEOUT, rx).await;
        self.pending.lock().unwrap().remove(&id);
        let _ = app.emit("command-confirm-done", &id);
        match answer {
            Ok(Ok(d)) => d,
            _ => Decision::Deny,
        }
    }

    /// 命令执行关闭时提醒用户一下去哪里开；同一台主机 10 分钟内只提醒一次
    fn notify_off(&self, app: &AppHandle, host_name: &str) {
        let mut last = self.off_notified.lock().unwrap();
        if last.get(host_name).is_some_and(|t| t.elapsed() < OFF_NOTIFY_EVERY) {
            return;
        }
        last.insert(host_name.to_string(), Instant::now());
        let _ = app
            .notification()
            .builder()
            .title(format!("{host_name} 上的 Claude 想在本机执行命令"))
            .body("命令执行现在是关闭的，已拒绝。需要的话到「MCP 工具箱 → cc-workstation → 命令执行」里开启。")
            .show();
    }

    /// 前端回答
    pub fn answer(&self, id: &str, decision: Decision) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(decision);
        }
    }

    /// 按模式决定这条命令能不能执行；返回 Some(规则) 表示用户选了「总是允许」，调用方负责写进白名单
    pub async fn check(
        &self,
        app: &AppHandle,
        mode: CommandMode,
        allowlist: &[String],
        host_name: &str,
        command: &str,
        cwd: &str,
    ) -> Result<Option<String>> {
        let chained = has_chaining(command);
        let (reason, rule) = match mode {
            CommandMode::Off => {
                self.notify_off(app, host_name);
                bail!(
                    "{host_name} 未开启本机命令执行。请提示用户在 cc-workstation「MCP 工具箱 → cc-workstation → 命令执行」里开启，或改用文件类工具。"
                )
            }
            CommandMode::All => return Ok(None),
            CommandMode::Confirm => ("当前为「每条确认」模式".to_string(), None),
            CommandMode::Allowlist => {
                if !chained && allowlist.iter().any(|r| matches_rule(command, r)) {
                    return Ok(None);
                }
                if chained {
                    ("命令里有 & | > < ; ^ 等拼接或重定向符号，白名单不自动放行".to_string(), None)
                } else {
                    ("不在白名单里".to_string(), program(command))
                }
            }
        };
        let req = ConfirmRequest {
            id: uuid::Uuid::new_v4().to_string(),
            host_name: host_name.into(),
            command: command.into(),
            cwd: cwd.into(),
            reason,
            rule,
            timeout_secs: CONFIRM_TIMEOUT.as_secs(),
        };
        match self.ask(app, req).await {
            Decision::Once => Ok(None),
            Decision::Always(rule) => Ok(Some(rule)),
            Decision::Deny => bail!(
                "用户拒绝了这条命令（或 {} 秒内无人确认），未执行。不要换个写法重试同一操作；确实需要的话先向用户说明理由。",
                CONFIRM_TIMEOUT.as_secs()
            ),
        }
    }
}

/// 命令里有这些字符就可能拼接、重定向出别的命令，白名单不自动放行
fn has_chaining(cmd: &str) -> bool {
    cmd.contains(['&', '|', '>', '<', ';', '^', '`', '\n', '\r']) || cmd.contains("$(")
}

/// 规范化程序名：去引号，小写，去掉 .exe/.cmd/.bat/.com；带路径的不算（可能是云端写进来的同名程序）
fn norm_program(token: &str) -> Option<String> {
    let t = token.trim_matches('"');
    if t.is_empty() || t.contains(['/', '\\', ':']) {
        return None;
    }
    let t = t.to_ascii_lowercase();
    let t = [".exe", ".cmd", ".bat", ".com"].iter().find_map(|ext| t.strip_suffix(ext)).unwrap_or(&t);
    Some(t.to_string())
}

/// 命令的程序名，作为「总是允许」默认规则
fn program(command: &str) -> Option<String> {
    command.split_whitespace().next().and_then(norm_program)
}

/// 规则按词匹配命令开头：「git」匹配 git 的所有子命令，「npm run build」只匹配这一条（可带后续参数）
fn matches_rule(command: &str, rule: &str) -> bool {
    let mut cmd = command.split_whitespace();
    let mut rule = rule.split_whitespace();
    let (Some(c), Some(r)) = (cmd.next(), rule.next()) else { return false };
    if norm_program(c).is_none() || norm_program(c) != norm_program(r) {
        return false;
    }
    rule.all(|r| cmd.next() == Some(r))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules() {
        assert!(matches_rule("git status", "git"));
        assert!(matches_rule("GIT.exe status -s", "git status"));
        assert!(!matches_rule("git push", "git status"));
        assert!(!matches_rule("gitk", "git"));
        assert!(!matches_rule(".\\git.exe status", "git"));
        assert!(matches_rule("npm run build -- --prod", "npm run build"));
        assert!(!matches_rule("npm run", "npm run build"));
        assert!(has_chaining("git status & del x"));
        assert!(has_chaining("git log > a.txt"));
        assert!(!has_chaining("git log --oneline -n 5"));
        assert_eq!(program("\"Mvn.cmd\" -q test").as_deref(), Some("mvn"));
    }
}
