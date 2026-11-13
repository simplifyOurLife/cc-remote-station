import { useEffect, useMemo, useRef, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { ActivityDialog, summarize } from "./ActivityDialog";
import { ChatView } from "./ChatView";
import { api, AuditEntry, errorText, Host, McpHostStatus } from "./api";
import { HostForm } from "./HostForm";
import { ImportDialog } from "./ImportDialog";
import { PrefsDialog } from "./PrefsDialog";
import { defaultPrefs, mergePrefs, UiPrefs } from "./prefs";
import { SettingsDialog } from "./SettingsDialog";
import { PaneControl, TerminalView } from "./TerminalView";
import { TmuxDialog } from "./TmuxDialog";
import "./App.css";

interface Pane {
  key: string;
  /** 图形对话窗格；缺省为终端 */
  kind?: "chat";
  /** 接回已有 tmux 会话时的会话名 */
  session?: string;
}

interface Tab {
  key: string;
  host: Host;
  /** 远端程序通过 OSC 0/2 设置的标题（取当前窗格的） */
  title: string;
  /** 后台响铃/通知过，切过去后清除 */
  attention: boolean;
  /** 分屏方向：row 左右，col 上下（同一标签内统一方向） */
  dir: "row" | "col";
  panes: Pane[];
  activePane: string;
}

type Dialog =
  | { kind: "host"; host: Host | null }
  | { kind: "settings" }
  | { kind: "prefs" }
  | { kind: "import" }
  | { kind: "activity" }
  | { kind: "tmux"; host: Host };

const newKey = () => crypto.randomUUID().replace(/-/g, "");
const UNGROUPED = "未分组";

export default function App() {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [prefs, setPrefs] = useState<UiPrefs>(defaultPrefs);
  const [showSnippets, setShowSnippets] = useState(false);
  /** 正在配置 Claude 的主机 id，用于按钮 loading */
  const [settingUp, setSettingUp] = useState<string | null>(null);
  /** 各窗格的控制句柄，快捷命令发到当前窗格 */
  const controls = useRef(new Map<string, PaneControl>());
  /** 各主机 MCP 反向转发状态（只含已连接且开启的） */
  const [mcpStatus, setMcpStatus] = useState<Map<string, McpHostStatus>>(new Map());
  /** 云端最近一次调用本机 MCP */
  const [lastActivity, setLastActivity] = useState<AuditEntry | null>(null);

  const reload = () => api.hostsList().then(setHosts).catch((e) => setError(errorText(e)));
  useEffect(() => {
    reload();
    api.uiPrefsGet().then((raw) => setPrefs(mergePrefs(raw)));
    const unlisten = listen<AuditEntry>("mcp-activity", (e) => setLastActivity(e.payload));
    // 连接建立/断开没有事件，轮询一下转发状态即可（本地调用，开销可忽略）
    const poll = () => api.mcpStatus().then((list) => setMcpStatus(new Map(list.map((s) => [s.hostId, s]))));
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      clearInterval(timer);
      unlisten.then((f) => f());
    };
  }, []);

  const savePrefs = (p: UiPrefs) => {
    setPrefs(p);
    api.uiPrefsSet(p).catch((e) => setError(errorText(e)));
  };

  const patchTab = (key: string, patch: Partial<Tab> | ((t: Tab) => Partial<Tab>)) =>
    setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)));

  const activate = (key: string) => {
    setActiveKey(key);
    patchTab(key, { attention: false });
  };

  const openTab = (host: Host, session?: string, kind?: "chat") => {
    const pane: Pane = { key: newKey(), session, kind };
    const tab: Tab = { key: newKey(), host, title: "", attention: false, dir: "row", panes: [pane], activePane: pane.key };
    setTabs((t) => [...t, tab]);
    setActiveKey(tab.key);
  };

  const closeTab = (key: string) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.key !== key);
      if (key === activeKey) setActiveKey(rest[rest.length - 1]?.key ?? null);
      return rest;
    });
  };

  const splitPane = (tabKey: string, dir: "row" | "col", kind?: "chat") => {
    const pane: Pane = { key: newKey(), kind };
    patchTab(tabKey, (t) => ({ dir, panes: [...t.panes, pane], activePane: pane.key }));
  };

  const closePane = (tab: Tab, paneKey: string) => {
    if (tab.panes.length === 1) return closeTab(tab.key);
    const rest = tab.panes.filter((p) => p.key !== paneKey);
    patchTab(tab.key, { panes: rest, activePane: rest[rest.length - 1].key });
  };

  const sendSnippet = (command: string, run: boolean) => {
    setShowSnippets(false);
    const tab = tabs.find((t) => t.key === activeKey);
    const ctl = tab && controls.current.get(tab.activePane);
    if (!ctl) return;
    ctl.send(run ? command + "\r" : command);
    ctl.focus();
  };

  const setupClaude = async (host: Host) => {
    setSettingUp(host.id);
    try {
      const out = await api.hostSetupClaude(host.id);
      await message(
        `已为 ${host.name} 上的 Claude Code 配好本机 MCP（ccws）。\n在该主机上新启动 claude 即可使用，输入 /mcp 可查看状态。\n\n${out}`,
        { title: "配置成功", kind: "info" },
      );
    } catch (e) {
      await message(errorText(e), { title: "配置失败", kind: "error" });
    } finally {
      setSettingUp(null);
    }
  };

  const remove = async (host: Host) => {
    if (!(await ask(`删除主机 ${host.name}？`, { title: "确认删除", kind: "warning" }))) return;
    await api.hostDelete(host.id).catch((e) => setError(errorText(e)));
    reload();
  };

  // 按分组归类并按搜索词过滤（匹配名称/地址/用户名/分组）
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groups = new Map<string, Host[]>();
    for (const h of hosts) {
      const g = h.group || UNGROUPED;
      const text = `${h.name} ${h.host} ${h.user} ${g}`.toLowerCase();
      if (q && !text.includes(q)) continue;
      groups.set(g, [...(groups.get(g) ?? []), h]);
    }
    // 未分组放最后，其余按名称排序
    return [...groups.entries()].sort(([a], [b]) => (a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b)));
  }, [hosts, filter]);
  const hasGroups = grouped.some(([g]) => g !== UNGROUPED);

  const toggleGroup = (g: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const hostItem = (h: Host) => (
    <li key={h.id} onDoubleClick={() => openTab(h)} title="双击连接">
      <div className="host-name">
        {h.name}
        {mcpStatus.has(h.id) && (
          <span
            className={`mcp-dot ${mcpStatus.get(h.id)!.state}`}
            title={
              mcpStatus.get(h.id)!.state === "ok"
                ? `本机 MCP 已转发到云端 127.0.0.1:${mcpStatus.get(h.id)!.detail}`
                : mcpStatus.get(h.id)!.detail
            }
          />
        )}
      </div>
      <div className="host-addr">
        {h.user}@{h.host}
        {h.port !== 22 && `:${h.port}`}
      </div>
      <div className="host-actions">
        <button onClick={() => openTab(h)}>连接</button>
        <button onClick={() => openTab(h, undefined, "chat")} title="图形界面和云端 Claude Code 对话">
          对话
        </button>
        {h.tmux && <button onClick={() => setDialog({ kind: "tmux", host: h })}>会话</button>}
        {h.mcp && (
          <button disabled={settingUp === h.id} onClick={() => setupClaude(h)} title="在云端执行 claude mcp add，需先连接">
            {settingUp === h.id ? "配置中…" : "配置 Claude"}
          </button>
        )}
        <button onClick={() => setDialog({ kind: "host", host: h })}>编辑</button>
        <button onClick={() => remove(h)}>删除</button>
      </div>
    </li>
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span>主机</span>
          <span>
            <button className="icon" title="从 ~/.ssh/config 导入" onClick={() => setDialog({ kind: "import" })}>
              ⇩
            </button>
            <button className="icon" title="新建主机" onClick={() => setDialog({ kind: "host", host: null })}>
              ＋
            </button>
          </span>
        </div>
        <div className="sidebar-search">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="搜索主机" />
        </div>
        {error && <p className="form-error">{error}</p>}
        <ul className="host-list">
          {grouped.map(([g, list]) =>
            hasGroups ? (
              <li key={g} className="group">
                <div className="group-head" onClick={() => toggleGroup(g)}>
                  {collapsed.has(g) && !filter ? "▸" : "▾"} {g} <span className="muted">{list.length}</span>
                </div>
                {(!collapsed.has(g) || filter) && <ul className="host-list nested">{list.map(hostItem)}</ul>}
              </li>
            ) : (
              list.map(hostItem)
            ),
          )}
          {hosts.length === 0 && <li className="empty">还没有主机，点右上角 ＋ 添加，或 ⇩ 从 ~/.ssh/config 导入</li>}
        </ul>
        <div className="sidebar-foot">
          <div className="activity-line" onClick={() => setDialog({ kind: "activity" })} title="查看云端操作记录与文件备份">
            {lastActivity ? (
              <>
                <span className={lastActivity.ok ? "ok" : "failed"}>{lastActivity.ok ? "●" : "✕"}</span>{" "}
                <code>{lastActivity.tool}</code> <span className="muted">{summarize(lastActivity)}</span>
              </>
            ) : (
              <span className="muted">云端操作记录</span>
            )}
          </div>
          <button onClick={() => setDialog({ kind: "prefs" })}>终端与快捷命令</button>
          <button onClick={() => setDialog({ kind: "settings" })}>本机访问设置</button>
        </div>
      </aside>

      <main className="workspace">
        <nav className="tabs">
          <div className="tab-strip">
            {tabs.map((t) => (
              <div
                key={t.key}
                className={`tab ${t.key === activeKey ? "active" : ""}`}
                title={t.title || t.host.name}
                onClick={() => activate(t.key)}
              >
                {t.attention && <span className="tab-dot" />}
                <span className="tab-title">
                  {t.host.name}
                  {t.panes.length > 1 && <span className="muted"> [{t.panes.length}]</span>}
                  {t.title && <span className="muted"> ▸ {t.title}</span>}
                </span>
                <button
                  className="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.key);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {activeKey && (
            <div className="tab-tools">
              <button className="icon" title="向右分屏（Ctrl+Shift+D）" onClick={() => splitPane(activeKey, "row")}>
                ‖
              </button>
              <button className="icon" title="向下分屏（Ctrl+Shift+E）" onClick={() => splitPane(activeKey, "col")}>
                ═
              </button>
              <button className="icon" title="在右侧并排一个新对话" onClick={() => splitPane(activeKey, "row", "chat")}>
                ＋对话
              </button>
              <div className="menu-anchor">
                <button className="icon" title="快捷命令" onClick={() => setShowSnippets((s) => !s)}>
                  ⚡
                </button>
                {showSnippets && (
                  <div className="menu" onMouseLeave={() => setShowSnippets(false)}>
                    {prefs.snippets.map((s) => (
                      <div key={s.id} className="menu-item" onClick={() => sendSnippet(s.command, s.run)}>
                        <span>{s.name}</span>
                        <code className="muted">{s.command}</code>
                      </div>
                    ))}
                    {prefs.snippets.length === 0 && <div className="menu-item muted">还没有快捷命令</div>}
                    <div
                      className="menu-item menu-foot"
                      onClick={() => {
                        setShowSnippets(false);
                        setDialog({ kind: "prefs" });
                      }}
                    >
                      管理快捷命令…
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </nav>
        <div className="panes">
          {tabs.map((t) => (
            <div
              key={t.key}
              className={`tab-body ${t.dir}`}
              style={{ display: t.key === activeKey ? "flex" : "none", flexDirection: t.dir === "row" ? "row" : "column" }}
            >
              {t.panes.map((p) =>
                p.kind === "chat" ? (
                  <ChatView
                    key={p.key}
                    host={t.host}
                    visible={t.key === activeKey}
                    focused={p.key === t.activePane}
                    onFocus={() => t.activePane !== p.key && patchTab(t.key, { activePane: p.key })}
                    onTitle={(title) => patchTab(t.key, { title })}
                    onAttention={() => t.key !== activeKey && patchTab(t.key, { attention: true })}
                  />
                ) : (
                <TerminalView
                  key={p.key}
                  host={t.host}
                  paneKey={p.key}
                  session={p.session}
                  visible={t.key === activeKey}
                  focused={p.key === t.activePane}
                  prefs={prefs.terminal}
                  onTitle={(title) => p.key === t.activePane && patchTab(t.key, { title })}
                  onAttention={() => t.key !== activeKey && patchTab(t.key, { attention: true })}
                  onFocus={() => t.activePane !== p.key && patchTab(t.key, { activePane: p.key })}
                  onSplit={(dir) => splitPane(t.key, dir)}
                  onClose={() => closePane(t, p.key)}
                  onControl={(ctl) => (ctl ? controls.current.set(p.key, ctl) : controls.current.delete(p.key))}
                />
                ),
              )}
            </div>
          ))}
          {tabs.length === 0 && <div className="placeholder">从左侧选择主机开始连接</div>}
        </div>
      </main>

      {dialog?.kind === "settings" && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "activity" && <ActivityDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "prefs" && <PrefsDialog prefs={prefs} onSave={savePrefs} onClose={() => setDialog(null)} />}
      {dialog?.kind === "tmux" && (
        <TmuxDialog
          host={dialog.host}
          onAttach={(name) => {
            openTab(dialog.host, name);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "import" && (
        <ImportDialog
          hosts={hosts}
          onDone={() => {
            setDialog(null);
            reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "host" && (
        <HostForm
          initial={dialog.host}
          hosts={hosts}
          onCancel={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
