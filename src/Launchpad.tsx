import { ChatSession, Host, McpHostStatus } from "./api";
import { Checklist } from "./Checklist";
import { Logo } from "./Logo";
import { Step } from "./onboarding";
import { kbd } from "./platform";

const MAX_HOSTS = 6;
const MAX_RECENT = 6;

interface Recent extends ChatSession {
  host: Host;
}

/** 从对话页的会话列表缓存（ccws.sessionList.<主机>.<目录>）里挑最近的会话，跨主机、按修改时间排 */
function recentSessions(hosts: Host[]): Recent[] {
  const seen = new Map<string, Recent>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? "";
      const host = hosts.find((h) => key.startsWith(`ccws.sessionList.${h.id}.`));
      if (!host) continue;
      const list: ChatSession[] = JSON.parse(localStorage.getItem(key) ?? "[]") ?? [];
      for (const s of list) {
        const k = `${host.id}/${s.sessionId}`;
        if (!seen.has(k)) seen.set(k, { ...s, host });
      }
    }
  } catch {
    // 缓存读不了就不显示最近对话
  }
  return [...seen.values()].sort((a, b) => b.mtime - a.mtime).slice(0, MAX_RECENT);
}

function ago(mtime: number) {
  const s = Math.max(0, Date.now() / 1000 - mtime);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(mtime * 1000).toLocaleDateString();
}

/** 工作区没有标签时的启动台：上手清单、主机快捷卡片、最近对话、快捷键 */
export function Launchpad({
  hosts,
  mcpStatus,
  onboarding,
  onTerminal,
  onChat,
  onAllHosts,
  onAddHost,
  onImport,
  onToolbox,
  onShortcuts,
}: {
  hosts: Host[];
  mcpStatus: Map<string, McpHostStatus>;
  onboarding: { steps: Step[]; done: number; total: number; hidden: boolean };
  onTerminal: (h: Host) => void;
  /** session 为空开新对话，否则接着这个会话 */
  onChat: (h: Host, session?: ChatSession) => void;
  onAllHosts: () => void;
  onAddHost: () => void;
  onImport: () => void;
  onToolbox: () => void;
  onShortcuts: () => void;
}) {
  const recent = recentSessions(hosts);
  // 最近用过的主机排前面
  const lastUsed = (h: Host) => Math.max(0, ...recent.filter((r) => r.host.id === h.id).map((r) => r.mtime));
  const shown = [...hosts].sort((a, b) => lastUsed(b) - lastUsed(a)).slice(0, MAX_HOSTS);
  const fresh = hosts.length === 0;

  return (
    <div className="launchpad">
      <header className="launchpad-head">
        <Logo size={44} />
        <div>
          <h2>{fresh ? "欢迎使用 cc-workstation" : "开始工作"}</h2>
          <p className="muted">{fresh ? "在云主机上跑 Claude Code，用本机的文件和工具。按下面的清单一步步来。" : "从一台主机开始，或接着上次的对话"}</p>
        </div>
      </header>

      {!onboarding.hidden && (
        <Checklist
          {...onboarding}
          hosts={hosts}
          onAddHost={onAddHost}
          onImport={onImport}
          onTerminal={onTerminal}
          onToolbox={onToolbox}
        />
      )}

      {fresh && onboarding.hidden && (
        <section className="launchpad-empty">
          <p className="muted">还没有主机。添加一台云主机，或从 ~/.ssh/config 导入。</p>
          <div className="row">
            <button onClick={onImport}>从 ssh config 导入</button>
            <button className="primary" onClick={onAddHost}>
              添加主机
            </button>
          </div>
        </section>
      )}

      {!fresh && (
        <section>
          <div className="launchpad-title">
            <span>主机</span>
            <button className="link" onClick={onAllHosts}>
              全部主机{hosts.length > MAX_HOSTS && `（${hosts.length}）`} →
            </button>
          </div>
          <div className="launchpad-hosts">
            {shown.map((h) => {
              const online = mcpStatus.has(h.id);
              return (
                <div key={h.id} className="launchpad-host">
                  <div className="launchpad-host-name">
                    <span className={`launchpad-dot ${online ? "on" : ""}`} title={online ? "已连接" : undefined} />
                    <span className="grow">{h.name}</span>
                    {h.group && <span className="muted small">{h.group}</span>}
                  </div>
                  <code className="muted">
                    {h.user}@{h.host}
                    {h.port !== 22 && `:${h.port}`}
                  </code>
                  <div className="launchpad-host-actions">
                    <button className="primary" title="图形界面和云端 Claude Code 协作" onClick={() => onChat(h)}>
                      对话
                    </button>
                    <button title="像 SSH 一样操作云主机" onClick={() => onTerminal(h)}>
                      终端
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <div className="launchpad-title">
            <span>最近对话</span>
          </div>
          <ul className="launchpad-recent">
            {recent.map((r) => (
              <li key={`${r.host.id}/${r.sessionId}`}>
                <button onClick={() => onChat(r.host, r)} title={r.cwd}>
                  <span className="launchpad-recent-title">{r.title || "（无标题）"}</span>
                  <span className="muted small">{r.host.name}</span>
                  <span className="muted small launchpad-recent-time">{ago(r.mtime)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="launchpad-keys muted small">
        <span>
          <kbd>{kbd("Ctrl+Alt+N")}</kbd> 新对话
        </span>
        <span>
          <kbd>{kbd("Ctrl+Tab")}</kbd> 切换标签
        </span>
        <span>
          <kbd>{kbd("Ctrl+F4")}</kbd> 关闭标签
        </span>
        <button className="link" onClick={onShortcuts}>
          全部快捷键（F1）
        </button>
      </footer>
    </div>
  );
}
