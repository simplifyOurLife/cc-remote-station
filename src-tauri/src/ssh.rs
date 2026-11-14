use anyhow::{Context, Result, bail, ensure};
use russh::ChannelMsg;
use russh::client::{self, ChannelOpenHandle, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::AgentClient;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{Algorithm, HashAlg, PublicKey, PublicKeyOrCertificate};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::hosts::{Auth, Host, HostStore, secret_get, secret_set};

/// 一条已认证的 SSH 连接。经跳板机时必须持有跳板机连接，否则隧道会被一起关掉。
pub struct Conn {
    pub handle: Handle<Client>,
    /// 工具箱的反向转发（每个勾选的工具一条）及其建立结果
    pub forwards: Vec<ForwardState>,
    _jump: Option<Box<Conn>>,
}

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
    /// 在独立通道上执行一条非交互命令，可选喂 stdin
    pub async fn exec(&self, cmd: &str, stdin: Option<&[u8]>) -> Result<ExecOutput> {
        let mut ch = self.handle.channel_open_session().await?;
        ch.exec(true, cmd).await?;
        if let Some(data) = stdin {
            ch.data(data).await?;
        }
        ch.eof().await?;
        let (mut code, mut stdout, mut stderr) = (None, Vec::new(), Vec::new());
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
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
    /// 云端端口 → 本机目标；云端经反向转发进来的连接按端口接到对应目标
    targets: HashMap<u32, (String, u16)>,
}

impl client::Handler for Client {
    type Error = anyhow::Error;

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
        let Some((host, port)) = self.targets.get(&connected_port).cloned() else {
            return Ok(()); // 丢弃 reply 即拒绝
        };
        reply.accept().await;
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                Ok(mut tcp) => {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
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
        ..Default::default()
    })
}

/// 连接并认证一台主机；配了跳板机就先递归连跳板机，再通过 direct-tcpip 隧道连目标。
/// forwards 在目标主机上逐条建立反向转发；转发失败不影响登录，只记在 Conn::forwards 里。
pub async fn connect(
    store: &HostStore,
    known_hosts: &Path,
    host: &Host,
    trust: Option<&TrustedKey>,
    creds: &Credentials,
    forwards: Vec<Forward>,
) -> Result<Conn> {
    let unknown = Arc::new(Mutex::new(None));
    let handler = Client {
        host: host.host.clone(),
        port: host.port,
        known_hosts: known_hosts.to_path_buf(),
        trust: trust.cloned(),
        unknown: unknown.clone(),
        targets: forwards.iter().map(|f| (f.remote_port.into(), (f.target_host.clone(), f.target_port))).collect(),
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
            let jump = Box::pin(connect(store, known_hosts, &jump_host, trust, creds, vec![]))
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

    authenticate(&mut handle, host, creds).await?;
    let mut states = Vec::new();
    for f in forwards {
        let error = match handle.tcpip_forward("127.0.0.1", f.remote_port.into()).await {
            Ok(_) => None,
            Err(e) => Some(format!(
                "云端端口 {} 反向转发失败：{e}。可能被占用（比如另一台电脑正连着这台主机、用了同一个端口，可在「MCP 工具箱 → 这台电脑」里换端口），或服务器禁止转发",
                f.remote_port
            )),
        };
        states.push(ForwardState {
            name: f.name,
            remote_port: f.remote_port,
            target: format!("{}:{}", f.target_host, f.target_port),
            error,
        });
    }
    Ok(Conn { handle, forwards: states, _jump: jump })
}

/// 密码/口令优先用弹窗里刚输入的，其次是凭据管理器里保存的；都没有或不对就返回 NeedSecret
async fn authenticate(handle: &mut Handle<Client>, host: &Host, creds: &Credentials) -> Result<()> {
    let user = host.user.as_str();
    let supplied = creds.secrets.get(&host.id).cloned();
    let secret = match &supplied {
        Some(s) => Some(s.clone()),
        None => secret_get(&host.id)?,
    };
    let need = |kind, wrong| NeedSecret { host_id: host.id.clone(), host_name: host.name.clone(), kind, wrong };
    let ok = match &host.auth {
        Auth::Password => {
            let Some(password) = secret.clone() else {
                return Err(need("password", false).into());
            };
            let mut ok = handle.authenticate_password(user, password.clone()).await?.success();
            // 不少服务器只开 keyboard-interactive，用同一个密码回答其提示
            if !ok {
                ok = keyboard_interactive(handle, user, &password).await?;
            }
            if !ok {
                return Err(need("password", true).into());
            }
            true
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
            let hash = rsa_hash(handle, key.algorithm()).await?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            handle.authenticate_publickey(user, key).await?.success()
        }
        Auth::Agent => authenticate_agent(handle, user).await?,
    };
    ensure!(ok, "{}@{} 认证失败", host.user, host.host);
    if let (true, Some(s)) = (creds.remember, supplied) {
        secret_set(&host.id, &s)?;
    }
    Ok(())
}

/// keyboard-interactive：把密码作为每个提示的答案。
/// TODO: 验证码类二次验证需要在握手中途弹窗，暂不支持
async fn keyboard_interactive(handle: &mut Handle<Client>, user: &str, password: &str) -> Result<bool> {
    let mut resp = handle.authenticate_keyboard_interactive_start(user, None::<String>).await?;
    for _ in 0..5 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
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
async fn authenticate_agent(handle: &mut Handle<Client>, user: &str) -> Result<bool> {
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

#[cfg(not(windows))]
async fn authenticate_agent(_handle: &mut Handle<Client>, _user: &str) -> Result<bool> {
    // TODO: macOS 版接 SSH_AUTH_SOCK
    bail!("当前平台暂不支持 agent 认证")
}

async fn try_agent_keys<S>(handle: &mut Handle<Client>, user: &str, mut agent: AgentClient<S>) -> Result<bool>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    for identity in agent.request_identities().await? {
        let key = identity.public_key().into_owned();
        let hash = rsa_hash(handle, key.algorithm()).await?;
        if handle.authenticate_publickey_with(user, key, hash, &mut agent).await?.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest.trim_start_matches(['/', '\\'])),
        _ => PathBuf::from(path),
    }
}
