import { useEffect, useState } from "react";
import { Loading } from "./Loading";
import { RefreshButton } from "./RefreshButton";
import { hostDateTime, tzLabel, useHostTz } from "./hostTime";
import { api, errorText, Host, TmuxSession } from "./api";

/** 列出主机上 cc-remote-station 建的 tmux 会话，可接回或结束 */
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
  /** 会话跑在云主机上，最后活动时间按主机时区显示 */
  const tz = useHostTz(host.id);

  /** 每次刷新完 +1，作列表 key 让条目重播闪入动画 */
  const [round, setRound] = useState(0);

  const load = () =>
    api
      .tmuxSessions(host.id)
      .then((list) => {
        setSessions(list);
        setError("");
        return list;
      })
      .catch((e) => {
        setError(errorText(e));
        return null;
      });
  useEffect(() => {
    load();
  }, []);

  const refresh = () => load().then((list) => (list ? `> 已刷新 · ${list.length} 个会话` : false));

  const kill = async (name: string) => {
    await api.tmuxKill(host.id, name).catch((e) => setError(errorText(e)));
    load();
  };

  return (
    <div className="terminal-overlay" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog settings">
        <h3>{host.name} 上的保持会话</h3>
        <p className="muted">关掉应用或断网后仍在云主机上运行的会话，可以接回继续用。</p>
        {error && <p className="form-error">{error}</p>}
        {sessions === null && !error && <Loading text="正在读取保持的会话" />}
        {sessions?.length === 0 && (
          <p key={round} className={`muted ${round ? "refreshed" : ""}`}>
            没有保持中的会话
          </p>
        )}
        <ul className="root-list" key={round}>
          {sessions?.map((s, i) => (
            <li key={s.name} className={round ? "refreshed" : undefined} style={{ animationDelay: `${i * 40}ms` }}>
              <span>
                <code>{s.name}</code>
                <span className="muted">
                  {" "}
                  {s.attached ? "已有终端连着" : "未连接"} · 最后活动 <span title={tzLabel(tz)}>{hostDateTime(s.activity, tz)}</span>
                </span>
              </span>
              <span className="row tmux-actions">
                <button className="primary" onClick={() => onAttach(s.name)}>
                  接回
                </button>
                <button className="danger" onClick={() => kill(s.name)}>
                  结束
                </button>
              </span>
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <RefreshButton onClick={refresh} onDone={() => setRound((n) => n + 1)} />
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
