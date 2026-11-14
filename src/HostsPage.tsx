import { useCallback, useMemo, useRef, useState } from "react";
import { describeForwards, forwardState, Host, hostToolbox, McpHostStatus, toolLabel } from "./api";
import { PopupMenu } from "./PopupMenu";

const UNGROUPED = "未分组";
const GUIDE_HIDDEN_KEY = "ccws.guideHidden";

interface Props {
  hosts: Host[];
  mcpStatus: Map<string, McpHostStatus>;
  /** 是否已经打开过终端或对话（引导第 2 步） */
  hasOpened: boolean;
  /** 是否已准备好工具箱：有允许的目录或启用的 MCP，且有主机开启了工具箱（引导第 3 步） */
  accessReady: boolean;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (h: Host) => void;
  onDelete: (h: Host) => void;
  onTerminal: (h: Host) => void;
  onChat: (h: Host) => void;
  onSessions: (h: Host) => void;
  onSetupClaude: (h: Host) => void;
  /** 单独配置这台主机用哪些 MCP 工具 */
  onTools: (h: Host) => void;
  onGoAccess: () => void;
}

function guideHidden() {
  try {
    return localStorage.getItem(GUIDE_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 首页：开始使用引导 + 主机卡片。每台主机的两个主操作（对话 / 终端）始终可见，其余收进 ⋯ 菜单 */
export function HostsPage(p: Props) {
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  /** 当前打开菜单的那个 ⋯ 按钮，菜单按它定位 */
  const menuBtn = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [hideGuide, setHideGuide] = useState(guideHidden);

  const steps = [
    { done: p.hosts.length > 0, title: "添加一台云主机", hint: "填地址和登录方式，或从 ~/.ssh/config 导入已有的主机" },
    { done: p.hasOpened, title: "开始对话或打开终端", hint: "对话：用图形界面和云端 Claude Code 协作；终端：像 SSH 一样操作云主机" },
    {
      done: p.accessReady,
      title: "把本机工具交给云端 Claude（可选）",
      hint: "在 MCP 工具箱里指定目录或添加本机 MCP，云端 Claude Code 就能读写你本机的项目、使用本机的浏览器等工具",
    },
  ];
  const allDone = steps.every((s) => s.done);
  const showGuide = !hideGuide && !allDone;

  const dismissGuide = () => {
    setHideGuide(true);
    try {
      localStorage.setItem(GUIDE_HIDDEN_KEY, "1");
    } catch {
      // 存不下只是下次还会显示
    }
  };

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groups = new Map<string, Host[]>();
    for (const h of p.hosts) {
      const g = h.group || UNGROUPED;
      if (q && !`${h.name} ${h.host} ${h.user} ${g}`.toLowerCase().includes(q)) continue;
      groups.set(g, [...(groups.get(g) ?? []), h]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)));
  }, [p.hosts, filter]);
  const hasGroups = grouped.some(([g]) => g !== UNGROUPED);

  const card = (h: Host) => {
    const st = p.mcpStatus.get(h.id);
    const state = forwardState(st);
    return (
      <article
        key={h.id}
        className={`host-card ${state === "ok" ? "live" : ""}`}
        // 双击卡片空白处开对话；双击在按钮上（如快速点两下「打开终端」）不算
        onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && p.onChat(h)}
      >
        <header className="host-card-head">
          <span className="host-card-name">{h.name}</span>
          {st && (
            <span
              className={`mcp-dot ${state}`}
              title={`工具箱端口映射：\n${describeForwards(st)}`}
            />
          )}
          <div className="host-card-more">
            <button
              ref={menu === h.id ? menuBtn : undefined}
              className="icon"
              title="更多操作"
              aria-haspopup="menu"
              aria-expanded={menu === h.id}
              onClick={() => setMenu(menu === h.id ? null : h.id)}
            >
              ⋯
            </button>
            {menu === h.id && (
              <PopupMenu anchor={menuBtn} onClose={closeMenu}>
                <div className="menu-item" onClick={() => p.onEdit(h)}>
                  编辑主机
                </div>
                {h.tmux && (
                  <div className="menu-item" onClick={() => p.onSessions(h)}>
                    <span>保持的会话</span>
                    <span className="muted menu-hint">接回断线前的终端</span>
                  </div>
                )}
                <div className="menu-item" onClick={() => p.onSetupClaude(h)}>
                  <span>MCP 工具</span>
                  <span className="muted menu-hint">选择工具并写入云端 Claude</span>
                </div>
                <div className="menu-item danger" onClick={() => p.onDelete(h)}>
                  删除主机
                </div>
              </PopupMenu>
            )}
          </div>
        </header>
        <div className="host-card-addr" title={`${h.user}@${h.host}${h.port !== 22 ? `:${h.port}` : ""}`}>
          {h.user}@{h.host}
          {h.port !== 22 && `:${h.port}`}
        </div>
        <div className="host-card-tags">
          {h.dir && <span title="默认工作目录">{h.dir}</span>}
          {h.jump && <span>经跳板机</span>}
          {h.tmux && <span>保持会话</span>}
          <button
            className={`tag-access tag-button ${h.mcp ? "" : "off"}`}
            title={h.mcp ? `使用的工具：${hostToolbox(h).map(toolLabel).join("、") || "无"}\n点击修改` : "未使用 MCP 工具箱，点击配置"}
            onClick={() => p.onTools(h)}
          >
            ▦ 工具箱 {h.mcp ? hostToolbox(h).length : "未用"}
          </button>
        </div>
        <footer className="host-card-actions">
          <button className="primary" onClick={() => p.onChat(h)}>
            开始对话
          </button>
          <button onClick={() => p.onTerminal(h)}>打开终端</button>
        </footer>
      </article>
    );
  };

  return (
    <div className="page wide">
      <header className="page-head">
        <div>
          <h1>主机</h1>
          <p className="muted">开始对话，用图形界面和云端 Claude Code 协作。</p>
        </div>
      </header>

      {showGuide && (
        <section className="guide">
          <div className="guide-head">
            <h3>开始使用</h3>
            <button className="link" onClick={dismissGuide}>
              不再显示
            </button>
          </div>
          <ol className="guide-steps">
            {steps.map((s, i) => (
              <li key={s.title} className={s.done ? "done" : ""}>
                <span className="guide-mark">{s.done ? "✓" : i + 1}</span>
                <div className="grow">
                  <div className="guide-title">{s.title}</div>
                  <div className="muted">{s.hint}</div>
                </div>
                {!s.done && i === 0 && (
                  <div className="row">
                    <button onClick={p.onImport}>从 ssh config 导入</button>
                    <button className="primary" onClick={p.onAdd}>
                      添加主机
                    </button>
                  </div>
                )}
                {!s.done && i === 1 && p.hosts.length > 0 && <span className="muted">在下方主机卡片上点「开始对话」</span>}
                {!s.done && i === 2 && <button onClick={p.onGoAccess}>去设置</button>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {p.hosts.length > 0 && (
        <div className="page-toolbar">
          <div className="search-box page-search">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setFilter("")}
              placeholder="按名称、地址、分组搜索"
            />
            {filter && (
              <button className="icon" title="清空（Esc）" aria-label="清空搜索" onClick={() => setFilter("")}>
                ✕
              </button>
            )}
          </div>
          <button onClick={p.onImport}>从 ssh config 导入</button>
          <button className="primary" onClick={p.onAdd}>
            添加主机
          </button>
        </div>
      )}

      {grouped.map(([g, list]) => (
        <section key={g} className="host-group">
          {hasGroups && (
            <h2 className="host-group-title">
              {g} <span className="muted">{list.length}</span>
            </h2>
          )}
          <div className="host-grid">{list.map(card)}</div>
        </section>
      ))}
      {p.hosts.length > 0 && grouped.length === 0 && <p className="muted">没有匹配「{filter}」的主机</p>}
      {/* 引导被关掉、又没有主机时，也要有地方添加 */}
      {p.hosts.length === 0 && !showGuide && (
        <section className="hosts-empty">
          <h3>还没有主机</h3>
          <p className="muted">添加一台云主机，或从 ~/.ssh/config 导入已有的主机。</p>
          <div className="row">
            <button onClick={p.onImport}>从 ssh config 导入</button>
            <button className="primary" onClick={p.onAdd}>
              添加主机
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
