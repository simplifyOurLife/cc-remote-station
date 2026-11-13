use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use crate::settings::Settings;

/// 云端访问本机的安全边界：路径白名单、写前备份、审计日志
pub struct Guard {
    pub settings: Arc<RwLock<Settings>>,
    audit_dir: PathBuf,
    backup_dir: PathBuf,
}

/// 备份索引里的一条：哪个文件在什么时候备份到了哪里
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    /// 备份文件名（在 backups 目录下），同时作为恢复时的 id
    pub id: String,
    pub original: String,
    /// 触发备份的工具，如 edit_file / delete_file / restore
    pub reason: String,
    pub ts: String,
    pub size: u64,
}

const BACKUP_KEEP_DAYS: u64 = 14;
const INDEX: &str = "index.jsonl";

impl Guard {
    pub fn new(settings: Arc<RwLock<Settings>>, data_dir: &Path) -> Self {
        let guard = Self { settings, audit_dir: data_dir.join("audit"), backup_dir: data_dir.join("backups") };
        guard.prune_backups();
        guard
    }

    /// 当前白名单（规范化后）；不存在的目录直接忽略
    pub fn roots(&self) -> Vec<PathBuf> {
        let roots = self.settings.read().unwrap().roots.clone();
        roots.iter().filter_map(|r| dunce::canonicalize(r).ok()).collect()
    }

    /// 校验路径在白名单内并返回规范化的绝对路径。
    /// 文件尚不存在时（新建）按父目录校验；规范化会解开 .. 和符号链接，防止越界。
    pub fn check(&self, path: &str) -> Result<PathBuf> {
        let p = PathBuf::from(path);
        ensure!(p.is_absolute(), "需要绝对路径：{path}");
        let resolved = match dunce::canonicalize(&p) {
            Ok(c) => c,
            Err(_) => {
                let parent = p.parent().context("路径无效")?;
                let name = p.file_name().context("路径无效")?;
                dunce::canonicalize(parent)
                    .with_context(|| format!("目录不存在：{}", parent.display()))?
                    .join(name)
            }
        };
        let roots = self.roots();
        ensure!(
            roots.iter().any(|r| resolved.starts_with(r)),
            "路径不在允许的目录内：{}。允许的目录：{}",
            resolved.display(),
            describe(&roots)
        );
        Ok(resolved)
    }

    /// 覆盖、修改或删除文件前备份一份，并在索引里记下原路径以便恢复
    pub fn backup(&self, path: &Path, reason: &str) -> Result<()> {
        if !path.is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.backup_dir)?;
        let millis = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis();
        let name = path.file_name().context("路径无效")?.to_string_lossy();
        let id = format!("{millis}-{name}");
        let size = std::fs::copy(path, self.backup_dir.join(&id))?;
        let entry = BackupEntry {
            id,
            original: path.display().to_string(),
            reason: reason.to_string(),
            ts: chrono::Local::now().to_rfc3339(),
            size,
        };
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(self.backup_dir.join(INDEX))?;
        writeln!(f, "{}", serde_json::to_string(&entry)?)?;
        Ok(())
    }

    /// 最近的备份（新的在前），备份文件已被清理的不列出
    pub fn list_backups(&self, limit: usize) -> Vec<BackupEntry> {
        let mut list: Vec<BackupEntry> = read_jsonl(&self.backup_dir.join(INDEX))
            .into_iter()
            .filter(|e: &BackupEntry| self.backup_dir.join(&e.id).is_file())
            .collect();
        list.reverse();
        list.truncate(limit);
        list
    }

    /// 把备份恢复到原位置。恢复前先备份当前版本，恢复本身也可以撤销
    pub fn restore(&self, id: &str) -> Result<String> {
        let entry = read_jsonl::<BackupEntry>(&self.backup_dir.join(INDEX))
            .into_iter()
            .find(|e| e.id == id)
            .context("备份不存在")?;
        let src = self.backup_dir.join(&entry.id);
        ensure!(src.is_file(), "备份文件已被清理");
        let target = PathBuf::from(&entry.original);
        self.backup(&target, "restore")?;
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::copy(&src, &target)?;
        Ok(entry.original)
    }

    /// 每次工具调用追加一行 JSON 到当天的审计文件；写失败只记日志，不影响工具本身
    pub fn audit(&self, entry: &Value) {
        let day = chrono::Local::now().format("%Y-%m-%d");
        let write = || -> Result<()> {
            std::fs::create_dir_all(&self.audit_dir)?;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.audit_dir.join(format!("{day}.jsonl")))?;
            writeln!(f, "{entry}")?;
            Ok(())
        };
        if let Err(e) = write() {
            log::warn!("写审计日志失败: {e:#}");
        }
    }

    /// 有审计记录的日期（新的在前）
    pub fn audit_days(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.audit_dir) else {
            return vec![];
        };
        let mut days: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".jsonl").map(str::to_string))
            .collect();
        days.sort_by(|a, b| b.cmp(a));
        days
    }

    /// 某天的审计记录（新的在前）
    pub fn audit_entries(&self, day: &str) -> Vec<Value> {
        // 日期会拼成文件名，只接受 YYYY-MM-DD
        if day.len() != 10 || !day.chars().all(|c| c.is_ascii_digit() || c == '-') {
            return vec![];
        }
        let mut list: Vec<Value> = read_jsonl(&self.audit_dir.join(format!("{day}.jsonl")));
        list.reverse();
        list
    }

    fn prune_backups(&self) {
        let Ok(entries) = std::fs::read_dir(&self.backup_dir) else {
            return;
        };
        let cutoff = SystemTime::now() - Duration::from_secs(BACKUP_KEEP_DAYS * 86400);
        for entry in entries.flatten() {
            if entry.file_name() == INDEX {
                continue;
            }
            let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < cutoff);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// 逐行解析 JSONL，跳过坏行；文件不存在返回空
fn read_jsonl<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
    let Ok(f) = std::fs::File::open(path) else {
        return vec![];
    };
    std::io::BufReader::new(f)
        .lines()
        .map_while(|l| l.ok())
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

pub fn describe(roots: &[PathBuf]) -> String {
    if roots.is_empty() {
        return "（未配置，请用户在 cc-workstation 「本机访问设置」里添加）".into();
    }
    roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join("；")
}
