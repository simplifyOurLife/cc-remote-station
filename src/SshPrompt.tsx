import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";

interface PromptRequest {
  id: string;
  hostName: string;
  name: string;
  instructions: string;
  prompts: { text: string; echo: boolean }[];
}

/**
 * SSH 登录中途的二次验证（验证码、动态口令等）：后端握手停住等这里的回答。
 * 挂在 App 根部，终端、对话、配置 Claude 等任何地方触发的连接都由它弹窗；多个请求排队依次问
 */
export function SshPromptHost() {
  const [queue, setQueue] = useState<PromptRequest[]>([]);
  const [values, setValues] = useState<string[]>([]);
  const cur = queue[0];

  useEffect(() => {
    const offAsk = listen<PromptRequest>("ssh-prompt", (e) => {
      setQueue((q) => [...q, e.payload]);
      // 窗口在托盘或后台时叫出来，验证码有时效
      const win = getCurrentWindow();
      win.show().then(() => win.setFocus()).catch(() => {});
    });
    // 后端超时或已回答：收掉对应弹窗
    const offDone = listen<string>("ssh-prompt-done", (e) => setQueue((q) => q.filter((r) => r.id !== e.payload)));
    return () => {
      offAsk.then((f) => f());
      offDone.then((f) => f());
    };
  }, []);

  useEffect(() => setValues(cur ? cur.prompts.map(() => "") : []), [cur?.id]);

  if (!cur) return null;

  const reply = (answers: string[] | null) => {
    api.sshPromptAnswer(cur.id, answers);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="terminal-overlay modal-overlay" onKeyDown={(e) => e.key === "Escape" && reply(null)}>
      <form
        className="dialog modal modal-info host-form ssh-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-prompt-title"
        onSubmit={(e) => {
          e.preventDefault();
          reply(values);
        }}
      >
        <h3 id="ssh-prompt-title">
          <span className="modal-mark">◆</span>
          {cur.hostName} · 二次验证
        </h3>
        <p className="muted ssh-prompt-hint">服务器在登录时要求额外验证，输入后继续连接。</p>
        {(cur.name || cur.instructions) && (
          <pre className="ssh-prompt-server">{[cur.name, cur.instructions].filter(Boolean).join("\n")}</pre>
        )}
        {cur.prompts.map((p, i) => (
          <label key={i}>
            {p.text.trim() || "输入"}
            <input
              type={p.echo ? "text" : "password"}
              autoFocus={i === 0}
              autoComplete="one-time-code"
              spellCheck={false}
              value={values[i] ?? ""}
              onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
            />
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" onClick={() => reply(null)}>
            取消连接
          </button>
          <button type="submit" className="primary">
            验证并连接
          </button>
        </div>
      </form>
    </div>
  );
}
