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
    /// 这台电脑的标识（如 home / office）。多台电脑连同一台主机时，云端的 MCP 名字加上它以免互相覆盖；空表示不加
    #[serde(default)]
    pub device: String,
    /// 内置工具在云端的自定义名字；空表示用默认（ccws，设了标识则 ccws-标识）
    #[serde(default)]
    pub builtin_alias: String,
    /// MCP 工具箱：本机其他 MCP 服务，挂在内置服务的 /mcp/<name> 下一起转发给云端
    #[serde(default)]
    pub toolbox: Vec<ToolboxItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxItem {
    /// 云端 claude mcp add 用的名字，也是路径段；只允许字母数字 - _
    pub name: String,
    /// 关闭后不再建立转发（本机命令立即拒绝访问）
    pub enabled: bool,
    /// 云主机上监听的端口（127.0.0.1），反向转发到本机目标
    #[serde(default)]
    pub remote_port: u16,
    /// 在云端 Claude Code 里的自定义名字；空表示用默认（名字，设了标识则 名字-标识）
    #[serde(default)]
    pub alias: String,
    #[serde(flatten)]
    pub source: Source,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Source {
    /// 本机命令（stdio），由 cc-workstation 启动并桥接成 HTTP
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Vec<KeyValue>,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// 本机或局域网的 HTTP MCP，原样转发；legacy_sse 为旧版 HTTP+SSE 协议
    Http {
        url: String,
        #[serde(default)]
        headers: Vec<KeyValue>,
        #[serde(default)]
        legacy_sse: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

/// 内置工具的内部 id（主机保存的工具列表里用它指代内置工具），工具箱条目不能重名
pub const BUILTIN_NAME: &str = "ccws";
/// 内置工具显示的名字，也是它默认的云端名字
pub const BUILTIN_CLOUD_NAME: &str = "cc-workstation";

impl Settings {
    /// 工具在云端 Claude Code 里的名字：有自定义名字就用它，否则设了电脑标识就加后缀，如 ccws-home
    pub fn cloud_name(&self, name: &str) -> String {
        let alias = if name == BUILTIN_NAME {
            self.builtin_alias.as_str()
        } else {
            self.toolbox.iter().find(|i| i.name == name).map_or("", |i| i.alias.as_str())
        };
        let base = if name == BUILTIN_NAME { BUILTIN_CLOUD_NAME } else { name };
        if !alias.is_empty() {
            alias.to_string()
        } else if self.device.is_empty() {
            base.to_string()
        } else {
            format!("{base}-{}", self.device)
        }
    }

    /// 所有工具的云端名字不能重复（否则写进云端会互相覆盖），且只含安全字符（会拼进云端命令）
    pub fn check_cloud_names(&self) -> Result<()> {
        let names: Vec<String> =
            std::iter::once(BUILTIN_NAME).chain(self.toolbox.iter().map(|i| i.name.as_str())).map(|n| self.cloud_name(n)).collect();
        for (i, n) in names.iter().enumerate() {
            anyhow::ensure!(
                !n.is_empty() && n.len() <= 48 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "云端名字「{n}」无效：只能用英文字母、数字、- 和 _"
            );
            anyhow::ensure!(!names[..i].contains(n), "云端名字「{n}」重复了");
        }
        Ok(())
    }

    pub fn load_or_init(path: &Path) -> Result<Self> {
        if path.exists() {
            return Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?);
        }
        let settings = Settings { token: new_token(), roots: vec![], allow_commands: false, remote_port: 47823, device: String::new(), builtin_alias: String::new(), toolbox: vec![] };
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
