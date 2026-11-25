import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "./modal";
import { hud } from "./copy";
import { api, ChatCacheInfo, errorText } from "./api";
import { promptSuggestionsOn, setPromptSuggestions } from "./prefs";

const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

/** 设置页「对话」：本机的对话偏好，改了即时保存 */
export function ChatPrefsPanel() {
  const [suggest, setSuggest] = useState(promptSuggestionsOn);
  return (
    <section className="page-card host-form">
      <h3>对话</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={suggest}
          onChange={(e) => {
            setSuggest(e.target.checked);
            setPromptSuggestions(e.target.checked);
          }}
        />
        预测下一步
      </label>
      <p className="muted small">
        每轮回复后，输入框里用灰字给出预测的下一句（如「按方案 B 调整」）：Tab 填入后可修改，Enter 直接发送，打字即忽略。每轮会多一次很小的请求（和对话共用缓存）。
        关掉后不再显示；新开或切换的对话不再请求预测。
      </p>
    </section>
  );
}

/** 设置页「会话缓存」：历史会话在本机的缓存目录、占用和清空 */
export function ChatCachePanel() {
  const [info, setInfo] = useState<ChatCacheInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.chatCacheInfo().then(setInfo).catch((e) => setError(errorText(e)));
  }, []);

  const run = async (job: () => Promise<ChatCacheInfo>, done: string) => {
    setBusy(true);
    setError("");
    try {
      setInfo(await job());
      hud(`> ${done}`);
    } catch (e) {
      setError(errorText(e));
      hud("> 操作失败 ✕", false);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const dir = await open({ directory: true, multiple: false, defaultPath: info?.dir });
    if (typeof dir === "string") run(() => api.chatCacheSetDir(dir), "缓存目录已更换");
  };

  const clear = async () => {
    if (!(await ask(`删除 ${info?.sessions ?? 0} 个会话的本机缓存？之后再打开这些会话会重新从云端读取。`, { title: "清空会话缓存", kind: "warning", okLabel: "清空" })))
      return;
    run(() => api.chatCacheClear(), "已清空会话缓存");
  };

  const custom = info && info.dir !== info.defaultDir;
  return (
    <section className="page-card host-form">
      <h3>会话缓存</h3>
      <p className="muted small">
        打开过的历史会话会缓存在本机，再次打开时先显示缓存，只从云端拉新增的部分，老会话基本秒开。缓存是明文的会话内容（可能含代码、命令输出等），
        超过 500 MB 时自动删掉最久没打开的。
      </p>
      {info && (
        <div className="row cache-row">
          <code className="grow cache-dir" title={info.dir}>
            {info.dir}
          </code>
          <span className="muted">
            {info.sessions} 个会话 · {size(info.bytes)}
          </span>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="row">
        <button disabled={busy || !info} onClick={pick}>
          更换目录…
        </button>
        {custom && (
          <button disabled={busy} onClick={() => run(() => api.chatCacheSetDir(null), "已恢复默认目录")}>
            恢复默认目录
          </button>
        )}
        <div className="grow" />
        <button className="danger" disabled={busy || !info?.sessions} onClick={clear}>
          清空缓存
        </button>
      </div>
      {custom && <p className="muted small">换目录后原目录里的缓存留在原地，不搬也不删；需要的话可以先清空再换。</p>}
    </section>
  );
}
