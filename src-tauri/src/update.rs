//! 在线升级：从 GitHub Releases 的 latest.json 检查新版本，下载签名过的安装包并安装
//! 逻辑放在 Rust 侧而不用插件的 JS 接口，是为了能按用户设置走代理（国内直连 GitHub 常不通）

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::CmdResult;

/// 检查到的新版本，安装时直接用，不再重新请求
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: String,
    date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// 空字符串表示不手动指定，跟随系统代理
fn updater(app: &AppHandle, proxy: &str) -> anyhow::Result<tauri_plugin_updater::Updater> {
    let mut b = app.updater_builder().timeout(Duration::from_secs(30));
    let proxy = proxy.trim();
    if !proxy.is_empty() {
        let url: Url = proxy.parse().map_err(|_| anyhow::anyhow!("代理地址格式不对，应类似 http://127.0.0.1:7890"))?;
        b = b.proxy(url);
    }
    Ok(b.build()?)
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>, proxy: String) -> CmdResult<Option<UpdateInfo>> {
    let update = updater(&app, &proxy)?.check().await.map_err(|e| anyhow::anyhow!("检查更新失败：{e}"))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.date().to_string()),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// 下载并安装，完成后重启。Windows 上安装程序会自己结束本进程，所有终端和对话随之断开
#[tauri::command]
pub async fn update_install(app: AppHandle, on_progress: Channel<Progress>) -> CmdResult<()> {
    let update = app.state::<Pending>().0.lock().unwrap().clone().ok_or_else(|| anyhow::anyhow!("请先检查更新"))?;
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| anyhow::anyhow!("下载或安装失败：{e}"))?;
    app.restart();
}
