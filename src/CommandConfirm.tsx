import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";

interface ConfirmRequest {
  id: string;
  hostName: string;
  command: string;
  cwd: string;
  reason: string;
  /** 可加进白名单的规则；null 不提供「总是允许」 */
  rule: string | null;
  timeoutSecs: number;
}

/**
 * 云端 Claude 要在本机执行命令时的确认弹窗：后端停在这里等回答，超时算拒绝。
 * 挂在 App 根部，多个请求排队依次问
 */
export function CommandConfirmHost() {
  const [queue, setQueue] = useState<(ConfirmRequest & { at: number })[]>([]);
  const [rule, setRule] = useState("");
  const [now, setNow] = useState(Date.now());
  const cur = queue[0];

  useEffect(() => {
    const offAsk = listen<ConfirmRequest>("command-confirm", (e) => {
      setQueue((q) => [...q, { ...e.payload, at: Date.now() }]);
      const win = getCurrentWindow();
      win.show().then(() => win.setFocus()).catch(() => {});
    });
    // 后端超时或已回答：收掉对应弹窗
    const offDone = listen<string>("command-confirm-done", (e) => setQueue((q) => q.filter((r) => r.id !== e.payload)));
    return () => {
      offAsk.then((f) => f());
      offDone.then((f) => f());
    };
  }, []);

  useEffect(() => setRule(cur?.rule ?? ""), [cur?.id]);

  useEffect(() => {
    if (!cur) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cur?.id]);

  if (!cur) return null;

  const left = Math.max(0, cur.timeoutSecs - Math.floor((now - cur.at) / 1000));
  const reply = (decision: "once" | "always" | "deny") => {
    api.commandConfirmAnswer(cur.id, decision, decision === "always" ? rule.trim() : null);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="terminal-overlay modal-overlay" onKeyDown={(e) => e.key === "Escape" && reply("deny")}>
      <div className="dialog modal modal-warning host-form command-confirm" role="alertdialog" aria-modal="true" aria-labelledby="command-confirm-title">
        <h3 id="command-confirm-title">
          <span className="modal-mark">◆</span>
          {cur.hostName} 请求在本机执行命令
        </h3>
        <pre className="command-confirm-cmd">{cur.command}</pre>
        <p className="muted small">
          工作目录 <code>{cur.cwd}</code>
          <br />
          {cur.reason}；{left} 秒后自动拒绝{queue.length > 1 && `；后面还有 ${queue.length - 1} 条在等`}
        </p>
        {cur.rule !== null && (
          <label className="command-confirm-rule">
            「总是允许」加入白名单的规则（按词匹配命令开头，可改得更窄，如 git status）：
            <input value={rule} onChange={(e) => setRule(e.target.value)} spellCheck={false} />
          </label>
        )}
        <div className="dialog-actions">
          <button onClick={() => reply("deny")} autoFocus>
            拒绝
          </button>
          <div className="grow" />
          {cur.rule !== null && (
            <button disabled={!rule.trim()} onClick={() => reply("always")}>
              总是允许
            </button>
          )}
          <button className="primary" onClick={() => reply("once")}>
            允许一次
          </button>
        </div>
      </div>
    </div>
  );
}
