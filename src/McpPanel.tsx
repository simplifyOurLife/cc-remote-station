import { useState } from "react";
import { Loading } from "./Loading";
import { McpServer, serverTools } from "./chatModel";

const STATUS: Record<string, { label: string; cls: string }> = {
  connected: { label: "已连接", cls: "ok" },
  failed: { label: "连接失败", cls: "error" },
  "needs-auth": { label: "需要登录", cls: "warn" },
  pending: { label: "连接中", cls: "idle" },
  disabled: { label: "已停用", cls: "idle" },
};

/** 图形界面版 /mcp：CLI 的 -p 模式只回一句统计，这里列出每个服务器的状态和工具，可重连、启停 */
export function McpPanel(p: {
  servers: McpServer[];
  tools: string[];
  /** 还没拿到任何状态（进程刚启动） */
  loading: boolean;
  pending: string | null;
  onReconnect: (name: string) => void;
  onToggle: (name: string, enabled: boolean) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const connected = p.servers.filter((s) => s.status === "connected").length;

  return (
    <div
      className="pane-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}
      onKeyDown={(e) => e.key === "Escape" && p.onClose()}
    >
      <div className="dialog mcp-panel" tabIndex={-1} ref={(el) => el?.focus()}>
        <h3>
          MCP 服务器 {p.servers.length > 0 && <span className="muted">{connected}/{p.servers.length} 已连接</span>}
        </h3>
        {p.servers.length === 0 && (
          p.loading ? <Loading text="正在读取 MCP 服务器状态" /> : <p className="muted">这台主机上的 Claude Code 没有配置 MCP 服务器。</p>
        )}
        <div className="mcp-list">
          {p.servers.map((s) => {
            const st = STATUS[s.status] ?? { label: s.status, cls: "idle" };
            const tools = serverTools(s, p.tools);
            const busy = p.pending === s.name;
            return (
              <div key={s.name} className="mcp-row">
                <div className="mcp-row-head">
                  <span className={`mcp-state ${st.cls}`} />
                  <span className="mcp-name">{s.name}</span>
                  <span className={`mcp-status-text ${st.cls}`}>{busy ? "处理中…" : st.label}</span>
                  {(s.scope || s.version) && (
                    <span className="muted mcp-meta">{[s.scope && `配置于 ${s.scope}`, s.version && `v${s.version}`].filter(Boolean).join("，")}</span>
                  )}
                  <div className="grow" />
                  {tools.length > 0 && (
                    <button className="link" onClick={() => setOpen(open === s.name ? null : s.name)}>
                      {tools.length} 个工具 {open === s.name ? "▴" : "▾"}
                    </button>
                  )}
                  {s.status !== "disabled" && (
                    <button disabled={busy} onClick={() => p.onReconnect(s.name)}>
                      重连
                    </button>
                  )}
                  <button disabled={busy} onClick={() => p.onToggle(s.name, s.status === "disabled")}>
                    {s.status === "disabled" ? "启用" : "停用"}
                  </button>
                </div>
                {s.error && <div className="form-error mcp-error">{s.error}</div>}
                {s.status === "needs-auth" && (
                  <div className="muted mcp-error">需要在终端里启动 claude，输入 /mcp 选中它完成登录。</div>
                )}
                {open === s.name && (
                  <div className="mcp-tools">
                    {tools.map((t) => (
                      <code key={t}>{t}</code>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="muted small">
          停用/启用只对当前会话生效。添加或删除服务器请在终端用 <code>claude mcp add</code> / <code>claude mcp remove</code>，新开对话后生效。
        </p>
        <div className="dialog-actions">
          <button onClick={p.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
