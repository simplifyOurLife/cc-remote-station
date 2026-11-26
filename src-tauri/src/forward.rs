//! 工具箱的云端端口映射。每台开了工具箱的主机一个后台任务守着端口：
//! 能免交互登录的主机单独起一条 SSH 连接只做转发，终端/对话的连接重连、被替换都碰不到端口；
//! 登录要验证码（或密码没保存）的主机借用终端/对话那条连接，那条换了就跟着换。
//! 端口被占（比如服务器上还留着没发现已断的旧会话）时隔一会儿重试，旧会话一释放就接上
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::AppState;
use crate::hosts::Host;
use crate::ssh::{self, Conn, Credentials, ForwardState, NeedPrompt, NeedSecret, UnknownHostKey};

/// 检查连接还在不在、该不该停的间隔
const TICK: Duration = Duration::from_secs(3);
/// 端口申请失败后的重试间隔
const RETRY_BIND: Duration = Duration::from_secs(10);
/// 独立连接连不上时从 2 秒起翻倍重连，最长隔这么久
const BACKOFF_MAX: Duration = Duration::from_secs(60);

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// own：独立连接；shared：借用终端/对话的连接；空串：还没连上
    pub mode: &'static str,
    /// 没连上时的原因
    pub note: Option<String>,
    pub forwards: Vec<ForwardState>,
}

struct Job {
    stop: Arc<Notify>,
    status: Arc<Mutex<Status>>,
    task: JoinHandle<()>,
}

pub struct Forwarders {
    app: AppHandle,
    jobs: Mutex<HashMap<String, Job>>,
}

impl Forwarders {
    pub fn new(app: AppHandle) -> Self {
        Self { app, jobs: Mutex::default() }
    }

    /// 没在跑就启动；已在跑不动它
    pub fn ensure(&self, host_id: &str) {
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.contains_key(host_id) {
            return;
        }
        let (stop, status) = (Arc::new(Notify::new()), Arc::new(Mutex::new(Status::default())));
        let task = tauri::async_runtime::spawn(run(self.app.clone(), host_id.to_string(), stop.clone(), status.clone()));
        jobs.insert(host_id.to_string(), Job { stop, status, task });
    }

    /// 停掉并等它撤完端口；返回之前是否在跑
    pub async fn halt(&self, host_id: &str) -> bool {
        let job = self.jobs.lock().unwrap().remove(host_id);
        let Some(job) = job else { return false };
        job.stop.notify_one();
        let _ = job.task.await;
        true
    }

    /// 主机配置改了：之前在跑、设了随应用启动、或已经连着这台主机的，按新配置重来
    pub async fn restart(&self, host: &Host) {
        let was = self.halt(&host.id).await;
        let connected = self.app.state::<AppState>().conns.lock().await.contains_key(&host.id);
        if host.mcp && (was || connected || host.mcp_autostart) {
            self.ensure(&host.id);
        }
    }

    /// 工具箱或端口设置改了：在跑的全部按新配置重来
    pub fn restart_all(&self) {
        let ids: Vec<String> = self.jobs.lock().unwrap().keys().cloned().collect();
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            for id in ids {
                if let Ok(host) = state.hosts.get(&id) {
                    state.forwarders.restart(&host).await;
                }
            }
        });
    }

    pub fn status(&self) -> Vec<(String, Status)> {
        let jobs = self.jobs.lock().unwrap();
        jobs.iter().map(|(id, j)| (id.clone(), j.status.lock().unwrap().clone())).collect()
    }
}

/// 等一段时间；期间被叫停返回 true
async fn wait(stop: &Notify, d: Duration) -> bool {
    tokio::time::timeout(d, stop.notified()).await.is_ok()
}

fn ptr(c: &Arc<Conn>) -> usize {
    Arc::as_ptr(c) as usize
}

async fn run(app: AppHandle, host_id: String, stop: Arc<Notify>, status: Arc<Mutex<Status>>) {
    let state = app.state::<AppState>();
    let set = |mode: &'static str, note: Option<String>, forwards: Vec<ForwardState>| {
        *status.lock().unwrap() = Status { mode, note, forwards };
    };
    let mut backoff = Duration::from_secs(2);
    // 独立连接登录需要用户参与时改借终端/对话的连接
    let mut borrow = false;
    // 因密码没保存或主机密钥没确认而改借的：记下当时池里的连接，用户重新登录（可能顺手保存了密码、
    // 确认了密钥）换了新连接后再试一次独立连接。要验证码的不再试，免得每次都多问一遍
    let mut retry_own_after: Option<usize> = None;
    loop {
        let Ok(host) = state.hosts.get(&host_id) else { return };
        let list = crate::host_forwards(&state, &host);
        if list.is_empty() {
            set("", None, vec![]);
            stop.notified().await;
            return;
        }
        let conn = if borrow {
            match crate::alive_conn(&state, &host_id).await {
                Some(c) if retry_own_after.is_some_and(|p| p != ptr(&c)) => {
                    (borrow, retry_own_after) = (false, None);
                    continue;
                }
                Some(c) => c,
                None => {
                    set("", Some("这台主机登录要输入验证码或密码，不能单独连接；打开终端或对话后借用它的连接".into()), vec![]);
                    if wait(&stop, TICK).await {
                        return;
                    }
                    continue;
                }
            }
        } else {
            match ssh::connect(&state.hosts, &state.known_hosts, &host, None, &Credentials::default(), None).await {
                Ok(c) => {
                    backoff = Duration::from_secs(2);
                    Arc::new(c)
                }
                Err(e) if e.is::<NeedPrompt>() => {
                    borrow = true;
                    continue;
                }
                Err(e) if e.is::<NeedSecret>() || e.is::<UnknownHostKey>() => {
                    borrow = true;
                    retry_own_after = Some(state.conns.lock().await.get(&host_id).map_or(0, ptr));
                    continue;
                }
                Err(e) => {
                    set("", Some(format!("连接失败，{} 秒后重试：{e:#}", backoff.as_secs())), vec![]);
                    if wait(&stop, backoff).await {
                        return;
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    continue;
                }
            }
        };

        let mode = if borrow { "shared" } else { "own" };
        let mut states: Vec<ForwardState> = list
            .iter()
            .map(|f| ForwardState {
                name: f.name.clone(),
                remote_port: f.remote_port,
                target: format!("{}:{}", f.target_host, f.target_port),
                error: Some(String::new()),
            })
            .collect();
        let mut next_bind = Instant::now();
        let stopped = loop {
            if Instant::now() >= next_bind && states.iter().any(|s| s.error.is_some()) {
                for (f, s) in list.iter().zip(&mut states) {
                    if s.error.is_some() {
                        s.error = conn.forward(f).await.err().map(|e| {
                            format!(
                                "云端端口 {} 申请失败：{e:#}。可能被占用（服务器上还留着本机已断开的旧会话，或另一台电脑连着这台主机用了同一端口，可在「MCP 工具箱 → 这台电脑」里换端口），或服务器禁止转发。每 {} 秒自动重试",
                                f.remote_port,
                                RETRY_BIND.as_secs()
                            )
                        });
                    }
                }
                next_bind = Instant::now() + RETRY_BIND;
                set(mode, None, states.clone());
            }
            if wait(&stop, TICK).await {
                break true;
            }
            let replaced = borrow && !state.conns.lock().await.get(&host_id).is_some_and(|c| Arc::ptr_eq(c, &conn));
            if replaced || conn.handle.is_closed() {
                break false;
            }
        };
        for (f, s) in list.iter().zip(&states) {
            if s.error.is_none() {
                conn.unforward(f.remote_port).await;
            }
        }
        if !borrow {
            let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
        }
        if stopped {
            return;
        }
        set("", Some("连接断开，正在重连".into()), vec![]);
    }
}
