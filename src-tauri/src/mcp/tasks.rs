//! 本机命令的执行与管理：前台命令等待完成，后台命令由云端用 command_output 分段取输出。
//! 超时或停止时结束整个进程树（cmd 启动的 mvn / npm 等子进程也一起结束）。

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};

/// 单个任务最多保留的输出字节，超出后丢弃最早的部分
const MAX_BUFFER: usize = 8 * 1024 * 1024;
/// 最多保留的已结束任务数
const KEEP_FINISHED: usize = 20;

pub struct Task {
    pub id: String,
    pub command: String,
    pid: Option<u32>,
    started: Instant,
    state: Mutex<TaskState>,
}

struct TaskState {
    /// 合并的 stdout + stderr 原始字节
    output: Vec<u8>,
    /// output[0] 对应的绝对偏移（前面的已因超出上限被丢弃）
    base: usize,
    /// None 运行中；Some(退出码，被结束时为 None)
    exit: Option<Option<i32>>,
}

/// 从 offset 起读取的一段输出
pub struct Chunk {
    pub text: String,
    pub next_offset: usize,
    pub exit: Option<Option<i32>>,
    /// 请求的 offset 已被丢弃，只能从仍保留的最早位置读
    pub skipped: bool,
}

impl Task {
    pub fn is_done(&self) -> bool {
        self.state.lock().unwrap().exit.is_some()
    }

    pub fn read_from(&self, offset: usize) -> Chunk {
        let st = self.state.lock().unwrap();
        let start = offset.max(st.base);
        let end = st.base + st.output.len();
        let bytes = &st.output[(start - st.base).min(st.output.len())..];
        Chunk { text: decode_console(bytes), next_offset: end, exit: st.exit, skipped: start > offset }
    }

    pub fn elapsed_secs(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    /// 等到任务结束、出现 offset 之后的新输出（only_done=false 时）或超时
    pub async fn wait(&self, offset: usize, timeout: Duration, only_done: bool) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            {
                let st = self.state.lock().unwrap();
                if st.exit.is_some() || (!only_done && st.base + st.output.len() > offset) {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    pub fn kill(&self) {
        if let (Some(pid), false) = (self.pid, self.is_done()) {
            kill_tree(pid);
        }
    }
}

#[derive(Default)]
pub struct Tasks {
    map: Mutex<HashMap<String, Arc<Task>>>,
}

impl Tasks {
    /// 启动命令并登记，输出在后台持续收集
    pub fn spawn(&self, command: &str, cwd: &Path) -> Result<Arc<Task>> {
        let mut cmd = shell_command(command);
        cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().context("启动命令失败")?;
        let task = Arc::new(Task {
            id: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
            command: command.to_string(),
            pid: child.id(),
            started: Instant::now(),
            state: Mutex::new(TaskState { output: Vec::new(), base: 0, exit: None }),
        });
        let stdout = child.stdout.take().context("无法读取输出")?;
        let stderr = child.stderr.take().context("无法读取输出")?;
        let t = task.clone();
        tokio::spawn(async move {
            tokio::join!(pump(stdout, &t), pump(stderr, &t));
            let code = child.wait().await.ok().and_then(|s| s.code());
            t.state.lock().unwrap().exit = Some(code);
        });
        self.register(task.clone());
        Ok(task)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Task>> {
        self.map.lock().unwrap().get(id).cloned()
    }

    pub fn list(&self) -> Vec<Arc<Task>> {
        let mut list: Vec<_> = self.map.lock().unwrap().values().cloned().collect();
        list.sort_by_key(|t| std::cmp::Reverse(t.started));
        list
    }

    /// 登记新任务，并把已结束的旧任务裁剪到 KEEP_FINISHED 个
    fn register(&self, task: Arc<Task>) {
        let mut map = self.map.lock().unwrap();
        map.insert(task.id.clone(), task);
        let mut finished: Vec<_> = map.values().filter(|t| t.is_done()).map(|t| (t.started, t.id.clone())).collect();
        if finished.len() > KEEP_FINISHED {
            finished.sort();
            for (_, id) in &finished[..finished.len() - KEEP_FINISHED] {
                map.remove(id);
            }
        }
    }
}

async fn pump<R: AsyncRead + Unpin>(mut reader: R, task: &Task) {
    let mut buf = [0u8; 8192];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let mut st = task.state.lock().unwrap();
        st.output.extend_from_slice(&buf[..n]);
        if st.output.len() > MAX_BUFFER {
            let drop = st.output.len() - MAX_BUFFER;
            st.output.drain(..drop);
            st.base += drop;
        }
    }
}

#[cfg(windows)]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn shell_command(command: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("cmd");
    // raw_arg：cmd 的引号规则和普通程序不同，原样传进去才不会被二次转义
    cmd.arg("/C").raw_arg(command).creation_flags(CREATE_NO_WINDOW);
    // 不从当前目录找程序：否则云端往工作目录写个 git.bat，白名单里的 git 就会跑它
    cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
    cmd
}

/// macOS / Linux：用用户的登录 shell（一般是 zsh），并放进独立进程组，结束时整组一起结束
#[cfg(not(windows))]
fn shell_command(command: &str) -> tokio::process::Command {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.arg("-c").arg(command).process_group(0);
    cmd
}

/// 结束进程及其所有子进程
#[cfg(windows)]
pub(super) fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// 子进程启动时用 process_group(0) 自成一组（组号 = pid），给负的组号发信号就是整组结束
#[cfg(not(windows))]
pub(super) fn kill_tree(pid: u32) {
    let group = format!("-{pid}");
    let _ = std::process::Command::new("kill").args(["-KILL", "--", &group]).output();
}

/// 中文 Windows 控制台程序多输出 GBK，先试 UTF-8 再退回 GB18030
pub fn decode_console(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GB18030.decode(bytes).0.into_owned(),
    }
}
