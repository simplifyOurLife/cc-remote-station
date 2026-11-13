import { useEffect, useState } from "react";
import { api, errorText, Host, TmuxSession } from "./api";

/** 列出主机上 cc-workstation 建的 tmux 会话，可接回或结束 */
export function TmuxDialog({
  host,
  onAttach,
  onClose,
}: {
  host: Host;
  onAttach: (name: string) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<TmuxSession[] | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    api
      .tmuxSessions(host.id)
      .then(setSessions)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    load();
  }, []);

  const kill = async (name: string) => {
    await api.tmuxKill(host.id, name).catch((e) => setError(errorText(e)));
    load();
  };

  return (
    <div className="terminal-overlay">
      <div className="dialog settings">
        <h3>{host.name} 上的保持会话</h3>
        <p className="muted">关掉应用或断网后仍在云主机上运行的会话，可以接回继续用。</p>
        {error && <p className="form-error">{error}</p>}
        {sessions === null && !error && <p className="muted">正在读取…</p>}
        {sessions?.length === 0 && <p className="muted">没有保持中的会话</p>}
        <ul className="root-list">
          {sessions?.map((s) => (
            <li key={s.name}>
              <span>
                <code>{s.name}</code>
                <span className="muted">
                  {" "}
                  {s.attached ? "已有终端连着" : "未连接"} · 最后活动 {new Date(s.activity * 1000).toLocaleString()}
                </span>
              </span>
              <span className="row">
                <button onClick={() => onAttach(s.name)}>接回</button>
                <button onClick={() => kill(s.name)}>结束</button>
              </span>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button onClick={load}>刷新</button>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
