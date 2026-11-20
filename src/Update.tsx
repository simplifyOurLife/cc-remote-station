import { useCallback, useEffect, useRef, useState } from "react";
import { noise } from "./SaveButton";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText, UpdateInfo, UpdateProgress } from "./api";

/** 发布页：在线升级失败时给用户手动下载；仓库地址和 tauri.conf.json 的 updater.endpoints 保持一致 */
export const RELEASES_URL = "https://github.com/simplifyOurLife/cc-remote-station/releases/latest";
const PROXY_KEY = "ccws-update-proxy";

function loadProxy(): string {
  try {
    return localStorage.getItem(PROXY_KEY) ?? "";
  } catch {
    return "";
  }
}

export interface Updater {
  current: string;
  info: UpdateInfo | null;
  checking: boolean;
  /** 上次检查的结果：未检查 / 已是最新 / 有新版本 / 出错 */
  status: "idle" | "latest" | "found" | "error";
  error: string;
  /** 上次检查完成的时刻（HH:MM:SS） */
  checkedAt: string;
  proxy: string;
  setProxy: (p: string) => void;
  check: () => Promise<Updater["status"]>;
}

/** 启动 5 秒后悄悄检查一次（失败不打扰，只在设置页显示），设置页可手动再查 */
export function useUpdater(): Updater {
  const [current, setCurrent] = useState("");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<Updater["status"]>("idle");
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [proxy, setProxyState] = useState(loadProxy);

  const setProxy = (p: string) => {
    setProxyState(p);
    try {
      localStorage.setItem(PROXY_KEY, p.trim());
    } catch {
      // 存不下只是下次启动要重填
    }
  };

  const check = useCallback(async () => {
    setChecking(true);
    setError("");
    let result: Updater["status"];
    try {
      const found = await api.updateCheck(loadProxy());
      setInfo(found);
      result = found ? "found" : "latest";
    } catch (e) {
      setError(errorText(e));
      result = "error";
    }
    setStatus(result);
    setCheckedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    setChecking(false);
    return result;
  }, []);

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
    // 开发模式没有发布版可比，不自动查
    if (import.meta.env.DEV) return;
    const t = setTimeout(check, 5000);
    return () => clearTimeout(t);
  }, [check]);

  return { current, info, checking, status, error, checkedAt, proxy, setProxy, check };
}

const mb = (n: number) => (n / 1048576).toFixed(1);

/** 新版本详情：版本号、更新说明、下载进度；安装会重启应用 */
export function UpdateDialog({ info, openTabs, onClose }: { info: UpdateInfo; openTabs: number; onClose: () => void }) {
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  const install = async () => {
    setInstalling(true);
    setError("");
    try {
      await api.updateInstall(setProgress);
    } catch (e) {
      setError(errorText(e));
      setInstalling(false);
      setProgress(null);
    }
  };

  const pct = progress?.total ? Math.min(100, (progress.downloaded / progress.total) * 100) : null;

  return (
    <div className="terminal-overlay modal-overlay" onKeyDown={(e) => e.key === "Escape" && !installing && onClose()}>
      <div className="dialog modal host-form update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <h3 id="update-title">
          <span className="modal-mark">↑</span>
          发现新版本 v{info.version}
        </h3>
        <p className="muted small">
          当前 v{info.current}
          {info.date && ` · 发布于 ${info.date}`}
        </p>
        <div className="update-notes">{info.notes.trim() || "这个版本没有写更新说明。"}</div>
        {installing ? (
          <div className="update-progress">
            <div className="update-bar">
              <div className={`update-bar-fill ${pct === null ? "indeterminate" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
            </div>
            <span className="muted small">
              {pct !== null && pct >= 100
                ? "下载完成，正在安装，应用即将重启…"
                : progress
                  ? `已下载 ${mb(progress.downloaded)}${progress.total ? ` / ${mb(progress.total)}` : ""} MB`
                  : "正在连接…"}
            </span>
          </div>
        ) : (
          <p className="muted small">
            安装时应用会重启
            {openTabs > 0 ? `，工作区里打开的 ${openTabs} 个标签会断开（接在 tmux 里的终端会话留在云端，重启后可以接回）` : ""}。
          </p>
        )}
        {error && (
          <UpdateAlert key={error} title="升级中断" message={error} hint="连不上 GitHub 的话，可以在「设置 → 在线升级」里填代理，或者到发布页手动下载安装包。" />
        )}
        <div className="dialog-actions">
          <button disabled={installing} onClick={onClose}>
            以后再说
          </button>
          <button onClick={() => openUrl(RELEASES_URL)}>打开发布页</button>
          <div className="grow" />
          <button className="primary" disabled={installing} onClick={install}>
            {installing ? "安装中…" : "下载并安装"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 终端风报错块：红色切角面板 + 扫描线，出现时信号撕裂一下 */
function UpdateAlert({ title, message, hint }: { title: string; message: string; hint?: string }) {
  return (
    <div className="update-alert" role="alert">
      <div className="update-alert-head">
        <span className="update-alert-tag">ERR</span>
        {title}
      </div>
      <div className="update-alert-msg">{message}</div>
      {hint && <div className="update-alert-hint">{hint}</div>}
    </div>
  );
}

/** 检查时按钮文字乱码跳动（红青错位），完成后按钮上方飘一行回执；失败时按钮撕裂一下 */
function CheckButton({ checking, onCheck }: { checking: boolean; onCheck: () => Promise<Updater["status"]> }) {
  const label = "检查更新";
  const [text, setText] = useState(label);
  const [result, setResult] = useState<{ status: Updater["status"]; n: number } | null>(null);
  const [hudOn, setHudOn] = useState(false);
  const timer = useRef(0);

  useEffect(() => {
    if (!checking) {
      setText(label);
      return;
    }
    timer.current = window.setInterval(() => setText(noise(label.length + 2)), 50);
    return () => clearInterval(timer.current);
  }, [checking]);

  const click = async () => {
    setHudOn(false);
    // 至少跳 0.4 秒乱码，结果回来太快看不到扫描感
    const [status] = await Promise.all([onCheck(), new Promise((r) => setTimeout(r, 400))]);
    setResult({ status, n: Date.now() });
    setHudOn(true);
  };

  const hud = result && {
    latest: { cls: "ok", text: "> UPLINK OK · 已是最新" },
    found: { cls: "found", text: "> NEW BUILD DETECTED" },
    error: { cls: "fail", text: "> SIGNAL LOST ✕" },
    idle: null,
  }[result.status];
  const failed = !checking && result?.status === "error";

  return (
    <span className="save-wrap">
      {hudOn && hud && (
        <span key={result!.n} className={`save-hud ${hud.cls}`} onAnimationEnd={() => setHudOn(false)}>
          {hud.text}
        </span>
      )}
      <button
        key={failed ? result!.n : "btn"}
        className={`update-check-btn${checking ? " busy" : ""}${failed ? " fail" : ""}`}
        disabled={checking}
        onClick={click}
      >
        <span className="update-check-glyph">⟳</span>
        <span className="update-check-text">{text}</span>
      </button>
    </span>
  );
}

/** 设置页里的「在线升级」：当前版本、手动检查、下载代理 */
export function UpdatePanel({ updater, onShow }: { updater: Updater; onShow: () => void }) {
  const { current, info, checking, status, error, checkedAt, proxy, setProxy, check } = updater;
  const readout = checking
    ? { cls: "scan", text: "正在连接发布源 github.com" }
    : status === "latest"
      ? { cls: "ok", text: `已是最新版本 · ${checkedAt}` }
      : status === "found" && info
        ? { cls: "found", text: `检测到新版本 v${info.version}${info.date ? ` · ${info.date} 发布` : ""}` }
        : status === "error"
          ? { cls: "fail", text: `检查失败 · ${checkedAt}` }
          : { cls: "", text: "尚未检查" };
  return (
    <section className="page-card host-form update-panel">
      <h3>在线升级</h3>
      <div className="update-row">
        <span className="update-ver" title="当前版本">
          <span className="update-ver-label">BUILD</span>v{current || "…"}
        </span>
        <span className={`update-readout ${readout.cls}`}>
          <span className="update-prompt">›_</span>
          {readout.text}
          {checking && <span className="caret">▌</span>}
        </span>
        <div className="grow" />
        {status === "found" && info && (
          <button className="primary" onClick={onShow}>
            查看并升级
          </button>
        )}
        <CheckButton checking={checking} onCheck={check} />
      </div>
      {status === "error" && !checking && <UpdateAlert key={checkedAt} title="检查更新失败" message={error} />}
      <label>
        下载代理：
        <input value={proxy} placeholder="留空跟随系统代理，如 http://127.0.0.1:7890" spellCheck={false} onChange={(e) => setProxy(e.target.value)} />
        <span className="muted small">新版本发布在 GitHub，直连不通时填本机代理地址（http 代理）。也可以到发布页手动下载安装包覆盖安装，配置不会丢。</span>
      </label>
    </section>
  );
}
