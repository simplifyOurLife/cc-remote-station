use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 本机 MCP 服务的设置，存在应用配置目录 settings.json
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 云端 Claude Code 访问本机 MCP 的令牌
    pub token: String,
    /// 允许云端访问的本机目录；为空时拒绝一切文件访问
    pub roots: Vec<String>,
    /// 是否允许云端在本机执行命令（默认关）
    pub allow_commands: bool,
    /// 云主机上反向转发监听的端口（127.0.0.1），云端 CC 的 MCP 地址用它
    pub remote_port: u16,
}

impl Settings {
    pub fn load_or_init(path: &Path) -> Result<Self> {
        if path.exists() {
            return Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?);
        }
        let settings = Settings { token: new_token(), roots: vec![], allow_commands: false, remote_port: 47823 };
        settings.save(path)?;
        Ok(settings)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp: PathBuf = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

/// uuid v4 含 122 位系统随机数，去掉连字符后做令牌足够
pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
