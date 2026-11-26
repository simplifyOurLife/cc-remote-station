use anyhow::{Context, Result, bail, ensure};
use russh::client::{self, AuthResult, ChannelOpenHandle, Handle, KeyboardInteractiveAuthResponse};
use russh::{ChannelMsg, MethodKind, MethodSet};
use tauri::Emitter;
use russh::keys::agent::client::AgentClient;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{Algorithm, HashAlg, PublicKey, PublicKeyOrCertificate};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::hosts::{Auth, Host, HostStore, secret_get, secret_set};

/// 一条已认证的 SSH 连接。经跳板机时必须持有跳板机连接，否则隧道会被一起关掉。
pub struct Conn {
    pub handle: Handle<Client>,
    /// 这条连接上已申请的反向转发（与 Client 共用）
    targets: Targets,
    _jump: Option<Box<Conn>>,
    /// 探测失败、已判定断开（TCP 可能还没关，is_closed 看不出来）
    dead: AtomicBool,
    /// 最近一次确认连接活着的时间：开通道成功、探测有回应，或收到任何通道数据（Client::data 更新）。
    /// 收数据也算：大块输出回传时 ping 的回应排在数据后面，高延迟链路上会超时，不能因此判死、掐断正在传的数据
    checked: Arc<Mutex<Instant>>,
}

/// 这么久内确认过活着的连接直接复用，不再探测
const PROBE_FRESH: Duration = Duration::from_secs(10);
/// 探测只等一个来回，这么久没回应就判定已断
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// 开通道也只等一个来回；死连接上会一直挂着，要等心跳超时（约 45 秒）才报错
const OPEN_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardState {
    pub name: String,
    pub remote_port: u16,
    /// 本机一侧的目标 host:port
    pub target: String,
    /// None 表示已建立
    pub error: Option<String>,
}

pub struct ExecOutput {
    pub code: u32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Conn {
    /// 复用前确认连接还活着：电脑睡眠、换网络后 TCP 往往已经断了而本地不知道，
    /// 不探测的话新开的终端、读历史都会挂在死连接上。判定断开时顺手断掉它，
    /// 挂在上面的终端标签立刻收到退出并自动重连
    pub async fn alive(self: &Arc<Self>) -> bool {
        if self.dead.load(Ordering::Relaxed) || self.handle.is_closed() {
            return false;
        }
        if self.checked.lock().unwrap().elapsed() < PROBE_FRESH {
            return true;
        }
        let ok = matches!(tokio::time::timeout(PROBE_TIMEOUT, self.handle.send_ping()).await, Ok(Ok(())))
            && !self.handle.is_closed();
        if ok {
            *self.checked.lock().unwrap() = Instant::now();
        } else {
            self.kill();
        }
        ok
    }

    fn kill(self: &Arc<Self>) {
        if self.dead.swap(true, Ordering::Relaxed) {
            return;
        }
        log::warn!("SSH 连接无响应，断开重连");
        let conn = self.clone();
        tokio::spawn(async move {
            let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "no response", "").await;
        });
    }

    /// 让云主机在 127.0.0.1:remote_port 上监听并转发到本机目标。先登记目标：云端一连进来就查得到
    pub async fn forward(&self, f: &Forward) -> Result<()> {
        let port = u32::from(f.remote_port);
        self.targets.lock().unwrap().insert(port, (f.target_host.clone(), f.target_port));
        let result = match tokio::time::timeout(OPEN_TIMEOUT, self.handle.tcpip_forward("127.0.0.1", port)).await {
            Ok(r) => r.map(|_| ()).map_err(Into::into),
            Err(_) => Err(anyhow::anyhow!("云主机 {} 秒无响应", OPEN_TIMEOUT.as_secs())),
        };
        if result.is_err() {
            self.targets.lock().unwrap().remove(&port);
        }
        result
    }

    /// 撤掉一条反向转发，云端端口随即空出来
    pub async fn unforward(&self, remote_port: u16) {
        let port = u32::from(remote_port);
        self.targets.lock().unwrap().remove(&port);
        let _ = tokio::time::timeout(PROBE_TIMEOUT, self.handle.cancel_tcpip_forward("127.0.0.1", port)).await;
    }

    /// 开会话通道，超时就判定连接已断
    pub async fn open_channel(self: &Arc<Self>) -> Result<russh::Channel<client::Msg>> {
        match tokio::time::timeout(OPEN_TIMEOUT, self.handle.channel_open_session()).await {
            Ok(ch) => {
                let ch = ch?;
                *self.checked.lock().unwrap() = Instant::now();
                Ok(ch)
            }
            Err(_) => {
                self.kill();
                bail!("云主机 {} 秒无响应，连接已断开，请重试", OPEN_TIMEOUT.as_secs())
            }
        }
    }

    /// 在独立通道上执行一条非交互命令，可选喂 stdin
    pub async fn exec(self: &Arc<Self>, cmd: &str, stdin: Option<&[u8]>) -> Result<ExecOutput> {
        let mut ch = self.open_channel().await?;
        ch.exec(true, cmd).await?;
        if let Some(data) = stdin {
            ch.data(data).await?;
        }
        ch.eof().await?;
        let (mut code, mut stdout, mut stderr, mut eof) = (None, Vec::new(), Vec::new(), false);
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Eof => eof = true,
                ChannelMsg::Close => {
                    eof = true;
                    break;
                }
                _ => {}
            }
        }
        // 服务器常在输出发完之前就先报退出码：通道没等到 EOF/关闭就断了，说明输出不完整，不能当结果用
        ensure!(eof, "连接中断，远端命令的输出不完整，请重试");
        let code = code.context("远端命令未返回退出码")?;
        Ok(ExecOutput { code, stdout, stderr })
    }
}

/// 把云主机 127.0.0.1:remote_port 反向转发到本机能访问的 target_host:target_port
/// （内置服务、本机 HTTP MCP，或局域网里的服务）
#[derive(Clone)]
pub struct Forward {
    pub name: String,
    pub remote_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

/// 用户在弹窗里确认过的主机密钥；只对 host:port + 指纹完全一致的那台生效
#[derive(Clone, Debug, Deserialize)]
pub struct TrustedKey {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

#[derive(Debug)]
pub struct UnknownHostKey {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

impl std::fmt::Display for UnknownHostKey {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "未知主机 {}:{}，指纹 {}", self.host, self.port, self.fingerprint)
    }
}

impl std::error::Error for UnknownHostKey {}

/// 缺少（或已保存的不对）密码 / 私钥口令，前端据此弹窗让用户输入后重连
#[derive(Debug)]
pub struct NeedSecret {
    pub host_id: String,
    pub host_name: String,
    /// "password" 或 "passphrase"
    pub kind: &'static str,
    /// 已经用某个密码试过且失败
    pub wrong: bool,
}

impl std::fmt::Display for NeedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        let what = if self.kind == "password" { "密码" } else { "私钥口令" };
        let state = if self.wrong { "不正确" } else { "未保存" };
        write!(f, "{} 的{what}{state}，请先打开终端连接并输入", self.host_name)
    }
}

impl std::error::Error for NeedSecret {}

/// 登录要用户现场输入（验证码等），而这次连接不能弹窗
#[derive(Debug)]
pub struct NeedPrompt;

impl std::fmt::Display for NeedPrompt {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("登录需要输入验证码")
    }
}

impl std::error::Error for NeedPrompt {}

/// 登录过程中服务器要的额外输入（验证码、动态口令等）：发 ssh-prompt 事件让前端弹窗，
/// 握手停在这里等用户回答（ssh_prompt_answer）。不重新连接，验证码不会因为重连而作废
pub struct Prompter {
    app: tauri::AppHandle,
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<Vec<String>>>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptRequest {
    id: String,
    host_name: String,
    name: String,
    instructions: String,
    prompts: Vec<PromptField>,
}

#[derive(Clone, serde::Serialize)]
struct PromptField {
    text: String,
    echo: bool,
}

impl Prompter {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app, pending: Mutex::default() }
    }

    async fn ask(&self, host_name: &str, name: &str, instructions: &str, prompts: Vec<PromptField>) -> Result<Vec<String>> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let count = prompts.len();
        let req = PromptRequest {
            id: id.clone(),
            host_name: host_name.into(),
            name: name.into(),
            instructions: instructions.into(),
            prompts,
        };
        self.app.emit("ssh-prompt", req)?;
        // 服务器一般给几分钟登录时间，超时后弹窗也要收掉
        let answer = tokio::time::timeout(Duration::from_secs(180), rx).await;
        self.pending.lock().unwrap().remove(&id);
        let _ = self.app.emit("ssh-prompt-done", &id);
        match answer {
            Ok(Ok(Some(a))) if a.len() == count => Ok(a),
            Ok(_) => bail!("已取消 {host_name} 的二次验证"),
            Err(_) => bail!("{host_name} 的二次验证等待超时，请重新连接"),
        }
    }

    /// 前端回答或取消（None）
    pub fn answer(&self, id: &str, answers: Option<Vec<String>>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(answers);
        }
    }
}

/// 用户在弹窗里临时输入的密码/口令（按主机 id，含跳板机）；
/// remember 为 true 时认证成功后存入系统凭据管理器
#[derive(Default)]
pub struct Credentials {
    pub secrets: HashMap<String, String>,
    pub remember: bool,
}

pub struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    trust: Option<TrustedKey>,
    unknown: Arc<Mutex<Option<String>>>,
    /// 云端经反向转发进来的连接按端口接到对应目标
    targets: Targets,
    /// 这条连接属于哪台主机，转发进来的连接登记到 PEERS
    host_id: String,
    /// 与 Conn::checked 共用：收到数据就刷新
    checked: Arc<Mutex<Instant>>,
}

/// 云端端口 → 本机目标 host:port
type Targets = Arc<Mutex<HashMap<u32, (String, u16)>>>;

/// 经反向转发接进本机的连接：本机一侧的源端口 → 主机 id。
/// 内置服务据此认出请求来自哪台主机（源端口由本机分配，云端伪造不了）
static PEERS: std::sync::LazyLock<Mutex<HashMap<u16, String>>> = std::sync::LazyLock::new(Mutex::default);

/// 本机连到内置服务的某个源端口属于哪台主机；不是经转发进来的（本机其他程序）为 None
pub fn peer_host(port: u16) -> Option<String> {
    PEERS.lock().unwrap().get(&port).cloned()
}

impl client::Handler for Client {
    type Error = anyhow::Error;

    async fn data(&mut self, _channel: russh::ChannelId, _data: &[u8], _session: &mut client::Session) -> Result<()> {
        *self.checked.lock().unwrap() = Instant::now();
        Ok(())
    }

    async fn extended_data(&mut self, _channel: russh::ChannelId, _ext: u32, _data: &[u8], _session: &mut client::Session) -> Result<()> {
        *self.checked.lock().unwrap() = Instant::now();
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<()> {
        let target = self.targets.lock().unwrap().get(&connected_port).cloned();
        let Some((host, port)) = target else {
            return Ok(()); // 丢弃 reply 即拒绝
        };
        reply.accept().await;
        let host_id = self.host_id.clone();
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                Ok(mut tcp) => {
                    // 先登记再转发数据：内置服务收到请求时一定查得到
                    let local = tcp.local_addr().ok().map(|a| a.port());
                    if let Some(p) = local {
                        PEERS.lock().unwrap().insert(p, host_id);
                    }
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
                    if let Some(p) = local {
                        PEERS.lock().unwrap().remove(&p);
                    }
                }
                Err(e) => log::warn!("连接本机 {host}:{port} 失败: {e}"),
            }
        });
        Ok(())
    }

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        let key = key.public_key();
        if is_known(&self.host, self.port, &key, &self.known_hosts)? {
            return Ok(true);
        }
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let trusted = self.trust.as_ref().is_some_and(|t| {
            t.host == self.host && t.port == self.port && t.fingerprint == fingerprint
        });
        if trusted {
            russh::keys::known_hosts::learn_known_hosts_path(
                &self.host,
                self.port,
                &key,
                &self.known_hosts,
            )?;
            return Ok(true);
        }
        *self.unknown.lock().unwrap() = Some(fingerprint);
        Ok(false)
    }
}

/// 先查本应用的 known_hosts，再查用户 ~/.ssh/known_hosts（复用 OpenSSH 已信任的主机）。
/// 任一处记录的密钥和当前不一致都直接拒绝。
fn is_known(host: &str, port: u16, key: &PublicKey, app_file: &Path) -> Result<bool> {
    use russh::keys::known_hosts::check_known_hosts_path;
    let user_file = dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"));
    for file in std::iter::once(app_file.to_path_buf()).chain(user_file) {
        match check_known_hosts_path(host, port, key, &file) {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(russh::keys::Error::KeyChanged { line }) => bail!(
                "{host}:{port} 的主机密钥与 {} 第 {line} 行记录不一致，可能遭到中间人攻击。确认服务器重装过的话，删掉该行后重连。",
                file.display()
            ),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(false)
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        // 优先开 zlib 压缩（服务器不支持就退回不压缩）：会话列表、命令输出这类文本能小好几倍，
        // 高延迟链路上传得快；zlib@openssh.com 认证后才启用，不影响握手
        preferred: russh::Preferred {
            compression: std::borrow::Cow::Borrowed(&[
                russh::compression::ZLIB_LEGACY,
                russh::compression::ZLIB,
                russh::compression::NONE,
            ]),
            ..russh::Preferred::DEFAULT
        },
        ..Default::default()
    })
}

/// 连接并认证一台主机；配了跳板机就先递归连跳板机，再通过 direct-tcpip 隧道连目标。
/// prompter 为 None 表示不能打扰用户（后台的转发连接）：服务器要验证码时返回 NeedPrompt。
pub async fn connect(
    store: &HostStore,
    known_hosts: &Path,
    host: &Host,
    trust: Option<&TrustedKey>,
    creds: &Credentials,
    prompter: Option<&Prompter>,
) -> Result<Conn> {
    let unknown = Arc::new(Mutex::new(None));
    let checked = Arc::new(Mutex::new(Instant::now()));
    let targets = Targets::default();
    let handler = Client {
        checked: checked.clone(),
        host: host.host.clone(),
        port: host.port,
        known_hosts: known_hosts.to_path_buf(),
        trust: trust.cloned(),
        unknown: unknown.clone(),
        targets: targets.clone(),
        host_id: host.id.clone(),
    };

    let (result, jump) = match &host.jump {
        None => {
            let addr = (host.host.as_str(), host.port);
            (client::connect(config(), addr, handler).await, None)
        }
        Some(jump_id) => {
            let jump_host = store.get(jump_id)?;
            // NeedSecret / UnknownHostKey 要原样传给前端弹窗，不能被 context 包住后丢掉类型——
            // anyhow 的 downcast 能穿透 context，这里照常加提示
            let jump = Box::pin(connect(store, known_hosts, &jump_host, trust, creds, prompter))
                .await
                .with_context(|| format!("跳板机 {} 连接失败", jump_host.name))?;
            let channel = jump
                .handle
                .channel_open_direct_tcpip(host.host.clone(), host.port.into(), "127.0.0.1", 0)
                .await
                .context("跳板机无法转发到目标主机")?;
            let stream = channel.into_stream();
            (client::connect_stream(config(), stream, handler).await, Some(Box::new(jump)))
        }
    };

    let mut handle = match result {
        Ok(h) => h,
        Err(e) => {
            if let Some(fingerprint) = unknown.lock().unwrap().take() {
                return Err(UnknownHostKey { host: host.host.clone(), port: host.port, fingerprint }.into());
            }
            return Err(e.context(format!("无法连接 {}:{}", host.host, host.port)));
        }
    };

    authenticate(&mut handle, host, creds, prompter).await?;
    Ok(Conn { handle, targets, _jump: jump, dead: AtomicBool::new(false), checked })
}

/// 密码/口令优先用弹窗里刚输入的，其次是凭据管理器里保存的；都没有或不对就返回 NeedSecret
async fn authenticate(handle: &mut Handle<Client>, host: &Host, creds: &Credentials, prompter: Option<&Prompter>) -> Result<()> {
    let user = host.user.as_str();
    let supplied = creds.secrets.get(&host.id).cloned();
    let secret = match &supplied {
        Some(s) => Some(s.clone()),
        None => secret_get(&host.id)?,
    };
    let need = |kind, wrong| NeedSecret { host_id: host.id.clone(), host_name: host.name.clone(), kind, wrong };
    let mut auth = Auth2fa { handle, user, host_name: &host.name, prompter, password: None, asked: false };
    let ok = match &host.auth {
        Auth::Password => {
            let Some(password) = secret.clone() else {
                return Err(need("password", false).into());
            };
            auth.password = Some(password.clone());
            let mut result = auth.handle.authenticate_password(user, password).await?;
            // 不少服务器只开 keyboard-interactive：密码提示自动用已有密码回答，验证码之类弹窗问用户
            if matches!(result, AuthResult::Failure { partial_success: false, .. }) {
                result = auth.keyboard_interactive().await?;
            }
            match auth.finish(result).await {
                Ok(true) => true,
                // 没问过用户就失败，基本是密码不对；问过验证码则密码和验证码都可能错，让用户重新输入密码再来一遍
                Ok(false) => return Err(need("password", true).into()),
                Err(e) => return Err(e),
            }
        }
        Auth::Key { path } => {
            let file = expand_home(path);
            ensure!(file.is_file(), "私钥文件不存在：{}", file.display());
            let key = match russh::keys::load_secret_key(&file, secret.as_deref()) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) => return Err(need("passphrase", false).into()),
                // 带了口令还解不开，基本就是口令不对
                Err(_) if secret.is_some() => return Err(need("passphrase", true).into()),
                Err(e) => return Err(anyhow::Error::new(e).context(format!("无法读取私钥 {path}"))),
            };
            let hash = rsa_hash(auth.handle, key.algorithm()).await?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            let result = auth.handle.authenticate_publickey(user, key).await?;
            auth.finish(result).await?
        }
        Auth::Agent => {
            let result = authenticate_agent(auth.handle, user).await?;
            auth.finish(result).await?
        }
    };
    ensure!(
        ok,
        "{}@{} 认证失败{}",
        host.user,
        host.host,
        if auth.asked { "：验证码不正确或已过期，请重新连接" } else { "" }
    );
    if let (true, Some(s)) = (creds.remember, supplied) {
        secret_set(&host.id, &s)?;
    }
    Ok(())
}

/// 第一种方式之后的认证：服务器回 partial_success（如 AuthenticationMethods publickey,keyboard-interactive）
/// 时继续走剩下的方式，遇到验证码就弹窗问用户
struct Auth2fa<'a> {
    handle: &'a mut Handle<Client>,
    user: &'a str,
    host_name: &'a str,
    prompter: Option<&'a Prompter>,
    /// 已有的登录密码：密码类提示直接用它回答，不再弹窗
    password: Option<String>,
    /// 是否弹窗问过用户（失败时据此提示验证码问题）
    asked: bool,
}

impl Auth2fa<'_> {
    async fn finish(&mut self, mut result: AuthResult) -> Result<bool> {
        for _ in 0..4 {
            match result {
                AuthResult::Success => return Ok(true),
                AuthResult::Failure { partial_success: false, .. } => return Ok(false),
                AuthResult::Failure { remaining_methods, .. } => result = self.next(&remaining_methods).await?,
            }
        }
        Ok(false)
    }

    async fn next(&mut self, remaining: &MethodSet) -> Result<AuthResult> {
        if remaining.contains(&MethodKind::KeyboardInteractive) {
            return self.keyboard_interactive().await;
        }
        if remaining.contains(&MethodKind::Password) {
            let password = match self.password.clone() {
                Some(p) => p,
                None => {
                    self.asked = true;
                    let field = PromptField { text: "密码：".into(), echo: false };
                    let mut a = self.prompter.ok_or(NeedPrompt)?.ask(self.host_name, "", "服务器要求再输入登录密码", vec![field]).await?;
                    a.remove(0)
                }
            };
            return Ok(self.handle.authenticate_password(self.user, password).await?);
        }
        let names: Vec<&str> = remaining.iter().map(<&str>::from).collect();
        bail!("服务器还要求 {} 认证，暂不支持", names.join(" / "))
    }

    /// keyboard-interactive：密码类提示（只答一次，防止密码错时无限重试）用已有密码，其余弹窗问用户
    async fn keyboard_interactive(&mut self) -> Result<AuthResult> {
        let mut password = self.password.clone();
        let mut resp = self.handle.authenticate_keyboard_interactive_start(self.user, None::<String>).await?;
        for _ in 0..8 {
            match resp {
                KeyboardInteractiveAuthResponse::Success => return Ok(AuthResult::Success),
                KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                    return Ok(AuthResult::Failure { remaining_methods, partial_success });
                }
                KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                    let mut answers: Vec<Option<String>> = prompts
                        .iter()
                        .map(|p| if is_password_prompt(&p.prompt) { password.take() } else { None })
                        .collect();
                    // 没有提示的轮次（只显示一段说明）直接回空答案
                    let ask: Vec<usize> = (0..prompts.len()).filter(|&i| answers[i].is_none()).collect();
                    if !ask.is_empty() {
                        self.asked = true;
                        let fields = ask.iter().map(|&i| PromptField { text: prompts[i].prompt.clone(), echo: prompts[i].echo }).collect();
                        let got = self.prompter.ok_or(NeedPrompt)?.ask(self.host_name, &name, &instructions, fields).await?;
                        for (i, a) in ask.into_iter().zip(got) {
                            answers[i] = Some(a);
                        }
                    }
                    let answers = answers.into_iter().map(Option::unwrap_or_default).collect();
                    resp = self.handle.authenticate_keyboard_interactive_respond(answers).await?;
                }
            }
        }
        bail!("服务器的验证步骤太多，已放弃")
    }
}

/// 「Password:」「密码：」这类提示用已保存的密码回答；验证码/口令（Verification code、OTP、Passcode…）交给用户
fn is_password_prompt(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    (p.contains("password") || p.contains("密码")) && !p.contains("one-time") && !p.contains("otp")
}

/// RSA 密钥要选服务器支持的最强签名哈希；其他算法不能带 hash
async fn rsa_hash(handle: &Handle<Client>, alg: Algorithm) -> Result<Option<HashAlg>> {
    if matches!(alg, Algorithm::Rsa { .. }) {
        Ok(handle.best_supported_rsa_hash().await?.flatten())
    } else {
        Ok(None)
    }
}

/// 优先 Windows OpenSSH agent，连不上再试 Pageant
#[cfg(windows)]
async fn authenticate_agent(handle: &mut Handle<Client>, user: &str) -> Result<AuthResult> {
    match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(agent) => try_agent_keys(handle, user, agent).await,
        Err(_) => {
            let agent = AgentClient::connect_pageant()
                .await
                .context("未找到运行中的 ssh-agent 或 Pageant")?;
            try_agent_keys(handle, user, agent).await
        }
    }
}

/// macOS / Linux：连 SSH_AUTH_SOCK 指向的 agent（macOS 由 launchd 自动提供，钥匙串里的密钥用 ssh-add --apple-use-keychain 加入）
#[cfg(unix)]
async fn authenticate_agent(handle: &mut Handle<Client>, user: &str) -> Result<AuthResult> {
    let agent = AgentClient::connect_env()
        .await
        .context("未找到运行中的 ssh-agent（SSH_AUTH_SOCK 未设置或无法连接）")?;
    try_agent_keys(handle, user, agent).await
}

/// 逐个试 agent 里的密钥；成功或 partial_success（还要二次验证）就停
async fn try_agent_keys<S>(handle: &mut Handle<Client>, user: &str, mut agent: AgentClient<S>) -> Result<AuthResult>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut last = AuthResult::Failure { remaining_methods: MethodSet::empty(), partial_success: false };
    for identity in agent.request_identities().await? {
        let key = identity.public_key().into_owned();
        let hash = rsa_hash(handle, key.algorithm()).await?;
        last = handle.authenticate_publickey_with(user, key, hash, &mut agent).await?;
        if matches!(last, AuthResult::Success | AuthResult::Failure { partial_success: true, .. }) {
            break;
        }
    }
    Ok(last)
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest.trim_start_matches(['/', '\\'])),
        _ => PathBuf::from(path),
    }
}
