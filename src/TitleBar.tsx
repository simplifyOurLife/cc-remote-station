import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "./platform";

const win = getCurrentWindow();

/**
 * 自绘标题栏（窗口去掉了系统边框）：左边显示当前位置，整条可拖动、双击最大化；
 * 右边是最小化 / 最大化（还原）/ 关闭。拖动区域的子元素不接收鼠标，点击都落在标题栏本身上
 */
export function TitleBar({ crumbs }: { crumbs: string[] }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const sync = () => win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    // macOS 用系统的红黄绿灯（标题栏叠在网页上），左边让出位置、不再画自己的三个按钮
    <header className={`titlebar ${isMac ? "mac" : ""}`} data-tauri-drag-region>
      <div className="titlebar-crumbs">
        <span className="titlebar-mark" aria-hidden="true" />
        {crumbs.map((c, i) => (
          <span key={i} className={i === crumbs.length - 1 ? "current" : ""}>
            {i > 0 && <span className="titlebar-sep">▸</span>}
            {c}
          </span>
        ))}
      </div>
      {!isMac && (
      <div className="titlebar-controls">
        <button className="win-btn" title="最小化" aria-label="最小化" onClick={() => win.minimize()}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 5.5h8" />
          </svg>
        </button>
        <button
          className="win-btn"
          title={maximized ? "还原" : "最大化"}
          aria-label={maximized ? "还原" : "最大化"}
          onClick={() => win.toggleMaximize()}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3 1.5h5.5V7" />
              <rect x="1.5" y="3" width="5.5" height="5.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" />
            </svg>
          )}
        </button>
        <button
          className="win-btn close"
          title={"关闭到托盘（终端和对话继续在后台运行）\n要退出请右键托盘图标 → 退出"}
          aria-label="关闭到托盘"
          onClick={() => win.close()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
          </svg>
        </button>
      </div>
      )}
    </header>
  );
}
