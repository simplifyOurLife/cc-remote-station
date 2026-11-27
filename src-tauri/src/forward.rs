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

/// 云主机上的端口登记：~/.cache/ccws/fwd-<端口> 记着替本机占着这个端口的 sshd 会话进程
/// （pid、启动时刻、哪台电脑）。sshd 会话进程不可转储，普通用户查不到谁占着端口，只能自己记。
/// exec 通道里 shell 的 $PPID 就是这条连接的 sshd 会话进程
const MARK_DIR: &str = "~/.cache/ccws";
/// 进程启动时刻（/proc/pid/stat 第 22 列），防 pid 被复用后误杀
const START_OF: &str = "sed 's/.*) //' /proc/$1/stat | cut -d' ' -f20";

/// 本机标识，只留字母数字，直接拼进云端命令
fn machine() -> String {
    let name = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let name: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if name.is_empty() { "pc".into() } else { name }
}

/// 记下这些端口现在由本连接的 sshd 会话占着
async fn mark(conn: &Arc<Conn>, ports: &[u16]) {
    let ports = ports.iter().map(u16::to_string).collect::<Vec<_>>().join(" ");
    let cmd = format!(
        "st() {{ {START_OF}; }}; d={MARK_DIR}; mkdir -p $d && s=$(st $PPID) && for p in {ports}; do echo \"$PPID $s {}\" > $d/fwd-$p; done",
        machine()
    );
    if let Err(e) = conn.exec(&cmd, None).await {
        log::warn!("登记云端端口失败：{e:#}");
    }
}

/// 端口申请失败时调用：登记的是本机、另一条（已断的）连接，且那个 sshd 进程还在，就结束它。
/// 别的电脑、别的程序占着的不碰。返回是否结束了旧会话
async fn reclaim(conn: &Arc<Conn>, port: u16) -> bool {
    let cmd = format!(
        "st() {{ {START_OF}; }}; read pid s who < {MARK_DIR}/fwd-{port} || exit 1; \
         [ \"$who\" = {} ] && [ \"$pid\" != \"$PPID\" ] && [ \"$(st $pid)\" = \"$s\" ] || exit 1; \
         case $(cat /proc/$pid/comm) in sshd*) ;; *) exit 1;; esac; kill $pid && echo $pid",
        machine()
    );
    match conn.exec(&cmd, None).await {
        Ok(o) if o.code == 0 => {
            log::warn!("云端端口 {port} 被本机已断开的旧会话占着，已结束它（PID {}）", String::from_utf8_lossy(&o.stdout).trim());
            true
        }
        _ => false,
    }
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
                let mut bound = vec![];
                for (f, s) in list.iter().zip(&mut states) {
                    if s.error.is_none() {
                        continue;
                    }
                    let mut r = conn.forward(f).await;
                    // 被本机以前留下的旧会话占着：结束它再申请一次，不干等服务器回收
                    if r.is_err() && reclaim(&conn, f.remote_port).await {
                        for _ in 0..5 {
                            tokio::time::sleep(Duration::from_millis(400)).await;
                            r = conn.forward(f).await;
                            if r.is_ok() {
                                break;
                            }
                        }
                    }
                    if r.is_ok() {
                        bound.push(f.remote_port);
                    }
                    s.error = r.err().map(|e| {
                        format!(
                            "云端端口 {} 申请失败：{e:#}。可能被占用（另一台电脑连着这台主机用了同一端口，或服务器上别的程序在用，可在「MCP 工具箱 → 这台电脑」里换端口），或服务器禁止转发。每 {} 秒自动重试",
                            f.remote_port,
                            RETRY_BIND.as_secs()
                        )
                    });
                }
                if !bound.is_empty() {
                    mark(&conn, &bound).await;
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
