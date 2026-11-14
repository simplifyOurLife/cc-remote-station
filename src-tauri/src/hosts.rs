use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "cc-workstation";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    /// 跳板机：引用另一台已保存主机的 id
    pub jump: Option<String>,
    /// 用远端 tmux 托底：断线后会话不死，重连自动接回
    #[serde(default)]
    pub tmux: bool,
    /// 允许该主机上的 Claude Code 经反向转发使用本机 MCP 服务
    #[serde(default)]
    pub mcp: bool,
    /// 这台主机用的工具箱条目（含内置的 ccws）及在这台主机上改过的云端名字/端口；None 表示只用内置工具
    #[serde(default)]
    pub tools: Option<Vec<HostTool>>,
    /// 侧栏分组名，空表示未分组
    #[serde(default)]
    pub group: Option<String>,
    /// 默认工作目录（云主机上的路径，可带 ~）：新终端和新对话都从这里开始。
    /// 主机配置存在本机，所以家里和公司的电脑可以对同一台云主机设不同目录
    #[serde(default)]
    pub dir: Option<String>,
}

/// 主机上的一个工具：名字指向工具箱条目，云端名字和端口可在这台主机上单独改
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTool {
    pub name: String,
    /// 空表示用工具箱里的云端名字
    #[serde(default)]
    pub alias: String,
    /// None 表示用工具箱里的云端端口
    #[serde(default)]
    pub remote_port: Option<u16>,
}

/// 密码 / 私钥口令不在这里，存在系统凭据管理器（见 secret_*）
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    Password,
    Key { path: String },
    Agent,
}

pub struct HostStore {
    path: PathBuf,
}

impl HostStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn list(&self) -> Result<Vec<Host>> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let text = std::fs::read_to_string(&self.path)?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn get(&self, id: &str) -> Result<Host> {
        self.list()?
            .into_iter()
            .find(|h| h.id == id)
            .with_context(|| format!("主机不存在: {id}"))
    }

    pub fn upsert(&self, mut host: Host) -> Result<Host> {
        if host.id.is_empty() {
            host.id = uuid::Uuid::new_v4().to_string();
        }
        let mut hosts = self.list()?;
        match hosts.iter_mut().find(|h| h.id == host.id) {
            Some(h) => *h = host.clone(),
            None => hosts.push(host.clone()),
        }
        self.write(&hosts)?;
        Ok(host)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut hosts = self.list()?;
        hosts.retain(|h| h.id != id);
        self.write(&hosts)?;
        secret_delete(id)
    }

    fn write(&self, hosts: &[Host]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // 先写临时文件再 rename，避免写一半崩溃把主机列表清空
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(hosts)?)?;
        std::fs::rename(tmp, &self.path)?;
        Ok(())
    }
}

fn entry(id: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, id)?)
}

pub fn secret_get(id: &str) -> Result<Option<String>> {
    match entry(id)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn secret_set(id: &str, secret: &str) -> Result<()> {
    Ok(entry(id)?.set_password(secret)?)
}

pub fn secret_delete(id: &str) -> Result<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
