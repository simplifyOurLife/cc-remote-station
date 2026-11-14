import { useEffect, useRef, useState } from "react";
import { ask, ModalHost } from "./modal";
import { listen } from "@tauri-apps/api/event";
import { DeviceSettings } from "./AccessSettings";
import { ActivityPanel, summarize } from "./ActivityPanel";
import { ChatView } from "./ChatView";
import { api, AuditEntry, errorText, forwardState, Host, hostToolbox, McpHostStatus, Settings } from "./api";
import { HostForm } from "./HostForm";
import { HostsPage } from "./HostsPage";
import { HostMcpDialog, McpStep } from "./HostMcpDialog";
import { ImportDialog } from "./ImportDialog";
import { Logo } from "./Logo";
import { PrefsPanel } from "./PrefsPanel";
import { defaultPrefs, mergePrefs, UiPrefs } from "./prefs";
import { PaneControl, TerminalView } from "./TerminalView";
import { TmuxDialog } from "./TmuxDialog";
import { ToolboxPage } from "./ToolboxPage";
import { TooltipLayer } from "./Tooltip";
import { TitleBar } from "./TitleBar";
import { PopupMenu } from "./PopupMenu";
import { SshPromptHost } from "./SshPrompt";
import { kbd } from "./platform";
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

/** 左侧导航的四个页面：每页只放一类事 */
type Page = "hosts" | "workspace" | "toolbox" | "settings";

type Dialog =
  | { kind: "host"; host: Host | null }
  | { kind: "import" }
  | { kind: "tmux"; host: Host }
  /** 主机的 MCP 配置：① 选工具 → ② 写入 Claude */
  | { kind: "mcp"; host: Host; step: McpStep };

const newKey = () => crypto.randomUUID().replace(/-/g, "");
const OPENED_KEY = "ccws.hasOpened";
const RAIL_KEY = "ccws.railCollapsed";

function loadOpened() {
  try {
    return localStorage.getItem(OPENED_KEY) === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const [page, setPage] = useState<Page>("hosts");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState("");
  const [prefs, setPrefs] = useState<UiPrefs>(defaultPrefs);
  const [access, setAccess] = useState<Settings | null>(null);
  const [hasOpened, setHasOpened] = useState(loadOpened);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showNewTab, setShowNewTab] = useState(false);
  const newTabBtn = useRef<HTMLButtonElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const snippetsBtn = useRef<HTMLButtonElement>(null);
  /** 左侧导航收起成只有图标的窄条（记在本机） */
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** 各窗格的控制句柄，快捷命令发到当前窗格 */
  const controls = useRef(new Map<string, PaneControl>());
  /** 各主机 MCP 反向转发状态（只含已连接且开启的） */
  const [mcpStatus, setMcpStatus] = useState<Map<string, McpHostStatus>>(new Map());
  /** 云端最近一次调用本机 MCP */
  const [lastActivity, setLastActivity] = useState<AuditEntry | null>(null);

  const reload = () =>
    api
      .hostsList()
      .then(setHosts)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    reload();
    api.uiPrefsGet().then((raw) => setPrefs(mergePrefs(raw)));
    api.settingsGet().then(setAccess);
    const unlisten = listen<AuditEntry>("mcp-activity", (e) => setLastActivity(e.payload));
    // 启动时从审计日志取最近一条，重启后也能显示真实的最后一次调用；已收到新事件就不覆盖
    api
      .auditDays()
      .then((days) => (days[0] ? api.auditEntries(days[0]) : []))
      .then((entries) => entries[0] && setLastActivity((cur) => cur ?? entries[0]))
      .catch(() => {});
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

  /** 新开标签并切到工作区；第一次打开时记下，引导第 2 步打勾 */
  const openTab = (host: Host, session?: string, kind?: "chat") => {
    const pane: Pane = { key: newKey(), session, kind };
    const tab: Tab = {
      key: newKey(),
      host,
      title: "",
      attention: false,
      dir: "row",
      panes: [pane],
      activePane: pane.key,
    };
    setTabs((t) => [...t, tab]);
    setActiveKey(tab.key);
    setPage("workspace");
    setShowNewTab(false);
    if (!hasOpened) {
      setHasOpened(true);
      try {
        localStorage.setItem(OPENED_KEY, "1");
      } catch {
        // 存不下只是引导下次还显示这一步
      }
    }
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
    patchTab(tabKey, (t) => ({
      dir,
      panes: [...t.panes, pane],
      activePane: pane.key,
    }));
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

  /** 打开主机的 MCP 弹窗：已选好工具就直接到「写入 Claude」，否则从「选择工具」开始 */
  const setupClaude = (host: Host) =>
    setDialog({ kind: "mcp", host, step: host.mcp && hostToolbox(host).length > 0 ? 2 : 1 });

  const remove = async (host: Host) => {
    if (
      !(await ask(`删除主机 ${host.name}？`, {
        title: "确认删除",
        kind: "warning",
        okLabel: "删除",
      }))
    )
      return;
    await api.hostDelete(host.id).catch((e) => setError(errorText(e)));
    reload();
  };

  const toolbox = access?.toolbox ?? [];
  const accessReady = !!access && (access.roots.length > 0 || toolbox.some((i) => i.enabled)) && hosts.some((h) => h.mcp);
  const attention = tabs.some((t) => t.attention);
  const mcpError = [...mcpStatus.values()].some((s) => forwardState(s) === "error");

  const toggleRail = () =>
    setRailCollapsed((c) => {
      try {
        localStorage.setItem(RAIL_KEY, c ? "0" : "1");
      } catch {
        // 存不下只是下次打开恢复展开
      }
      return !c;
    });

  const navItem = (key: Page, icon: string, label: string, extra?: React.ReactNode) => (
    <button
      className={`rail-item ${page === key ? "active" : ""}`}
      aria-current={page === key ? "page" : undefined}
      aria-label={label}
      title={railCollapsed ? label : undefined}
      onClick={() => {
        setPage(key);
        // 回到工作区就算看过当前标签了
        if (key === "workspace" && activeKey) patchTab(activeKey, { attention: false });
      }}
    >
      <span className="rail-icon">{icon}</span>
      <span className="rail-label">{label}</span>
      {extra}
    </button>
  );

  // 标题栏里的位置：页面，工作区再加上当前标签的主机和类型
  // 当前标签滚到可见位置（新开的标签可能在标签栏右边看不到的地方）
  useEffect(() => {
    tabStrip.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs.length, page]);

  const activeTab = tabs.find((t) => t.key === activeKey);
  const crumbs = [
    "cc-workstation",
    { hosts: "主机", workspace: "工作区", toolbox: "MCP 工具箱", settings: "设置" }[page],
    ...(page === "workspace" && activeTab
      ? [`${activeTab.host.name} · ${activeTab.panes.find((p) => p.key === activeTab.activePane)?.kind === "chat" ? "对话" : "终端"}`]
      : []),
  ];

  return (
    <div className="app-shell">
      <TitleBar crumbs={crumbs} />
      <div className="app">
      <nav className={`rail ${railCollapsed ? "collapsed" : ""}`} aria-label="主导航">
        <div className="rail-brand" title={railCollapsed ? "cc-workstation · 云端 Claude Code 工作台" : undefined}>
          <Logo />
          <div className="rail-brand-text">
            <span className="brand">cc-workstation</span>
            <span className="muted rail-tagline">云端 Claude Code 工作台</span>
          </div>
        </div>
        {navItem("hosts", "▣", "主机")}
        {navItem(
          "workspace",
          "▤",
          "工作区",
          <>
            {tabs.length > 0 && <span className="rail-count">{tabs.length}</span>}
            {attention && <span className="tab-dot" title="有后台标签在等你" />}
          </>,
        )}
        {navItem("toolbox", "▦", "MCP 工具箱", mcpError && <span className="mcp-dot error" title="有主机的端口映射建立失败" />)}
        {navItem("settings", "⚙", "设置")}
        <div className="grow" />
        <button
          className="rail-foot activity-line"
          onClick={() => setPage("toolbox")}
          title={
            railCollapsed && lastActivity
              ? `工具箱动态：${lastActivity.ok ? "●" : "✕"} ${lastActivity.tool} ${summarize(lastActivity)}\n点击查看全部记录`
              : "云端 Claude 最近一次使用工具箱，点击查看全部记录"
          }
        >
          {/* 收起时只留一个状态点 */}
          <span className={`activity-dot ${lastActivity ? (lastActivity.ok ? "ok" : "failed") : ""}`}>›_</span>
          <span className="activity-head">
            ›_ 工具箱动态<span className="caret">▌</span>
          </span>
          <span className="activity-body">
            {lastActivity ? (
              <>
                <span className={lastActivity.ok ? "ok" : "failed"}>{lastActivity.ok ? "●" : "✕"}</span> <code>{lastActivity.tool}</code>{" "}
                <span className="muted">{summarize(lastActivity)}</span>
              </>
            ) : (
              <span className="muted">云端还没有用过工具箱</span>
            )}
          </span>
        </button>
        <button className="rail-toggle" title={railCollapsed ? "展开导航" : "收起导航，给工作区让出空间"} onClick={toggleRail}>
          {railCollapsed ? "»" : "« 收起"}
        </button>
      </nav>

      <main className="main">
        {error && (
          <div className="app-error">
            {error}
            <button className="icon" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}

        {page === "hosts" && (
          <HostsPage
            hosts={hosts}
            mcpStatus={mcpStatus}
            hasOpened={hasOpened}
            accessReady={accessReady}
            onAdd={() => setDialog({ kind: "host", host: null })}
            onImport={() => setDialog({ kind: "import" })}
            onEdit={(h) => setDialog({ kind: "host", host: h })}
            onDelete={remove}
            onTerminal={(h) => openTab(h)}
            onChat={(h) => openTab(h, undefined, "chat")}
            onSessions={(h) => setDialog({ kind: "tmux", host: h })}
            onSetupClaude={setupClaude}
            onTools={(h) => setDialog({ kind: "mcp", host: h, step: 1 })}
            onGoAccess={() => setPage("toolbox")}
          />
        )}

        {page === "toolbox" && (
          <div className="page">
            <header className="page-head">
              <div>
                <h1>MCP 工具箱</h1>
                <p className="muted">把本机的 MCP 服务经 SSH 端口映射共享给云端 Claude Code，每个工具一条映射（本机 → 云端端口）。</p>
                <p className="muted">步骤：在这里添加工具 → 编辑主机勾选要用的工具 → 对主机点「配置 Claude」。</p>
              </div>
            </header>

            <div className="page-columns">
              <div>
                <ToolboxPage
                  builtinPort={access?.remotePort ?? 0}
                  device={access?.device ?? ""}
                  builtinAlias={access?.builtinAlias ?? ""}
                  items={toolbox}
                  onItemsChange={(items) => setAccess((a) => a && { ...a, toolbox: items })}
                  onAccessSaved={setAccess}
                />
                <ActivityPanel refreshKey={lastActivity?.ts} />
              </div>

              <div>
                <section className="page-card">
                  <h3>主机</h3>
                  <p className="muted">开启了工具箱的主机和当前的端口映射。点「MCP 工具」选工具并写入 Claude。</p>
                  {hosts.filter((h) => h.mcp).length === 0 && (
                    <p className="muted empty-note">还没有主机开启工具箱。在主机卡片上点「工具箱」标签即可开启。</p>
                  )}
                  <ul className="root-list access-hosts">
                    {hosts
                      .filter((h) => h.mcp)
                      .map((h) => {
                        const st = mcpStatus.get(h.id);
                        return (
                          <li key={h.id} className="access-host">
                            <span className="grow">
                              <b>{h.name}</b> {!st && <span className="muted">未连接：打开它的对话或终端后建立映射</span>}
                              {st && (
                                <span className="forward-list">
                                  {st.forwards.map((f) => (
                                    <span key={f.name} className={f.error ? "form-error inline" : ""} title={f.error ?? undefined}>
                                      {f.error ? "✕" : "●"} {f.name}{" "}
                                      <span className="muted">
                                        {f.target} → 云端 :{f.remotePort}
                                      </span>
                                    </span>
                                  ))}
                                </span>
                              )}
                            </span>
                            <button onClick={() => setupClaude(h)}>MCP 工具</button>
                          </li>
                        );
                      })}
                  </ul>
                </section>
                <DeviceSettings onSaved={setAccess} />
              </div>
            </div>
          </div>
        )}

        {page === "settings" && (
          <div className="page">
            <header className="page-head">
              <div>
                <h1>设置</h1>
                <p className="muted">终端的外观和快捷命令，保存后立即作用到所有已打开的终端。</p>
              </div>
            </header>
            <PrefsPanel prefs={prefs} onSave={savePrefs} />
          </div>
        )}

        {/* 工作区始终挂着，只是切到其他页时隐藏：卸载会断开所有终端和对话 */}
        <div className="workspace" style={{ display: page === "workspace" ? "flex" : "none" }}>
          <nav className="tabs">
            <div
              className="tab-strip"
              ref={tabStrip}
              // 标签多到溢出时，竖向滚轮转成横向滚动
              onWheel={(e) => {
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
              }}
            >
              {tabs.map((t) => (
                <div
                  key={t.key}
                  className={`tab ${t.key === activeKey ? "active" : ""}`}
                  title={`${t.title || t.host.name}\n中键点击关闭`}
                  onClick={() => activate(t.key)}
                  // 中键关闭（和浏览器一致）；mousedown 拦掉中键自动滚动
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                  onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
                >
                  {t.attention && <span className="tab-dot" />}
                  <span className="tab-kind">{t.panes[0].kind === "chat" ? "对话" : "终端"}</span>
                  <span className="tab-title">
                    {t.host.name}
                    {t.panes.length > 1 && <span className="muted"> [{t.panes.length}]</span>}
                    {t.title && <span className="muted"> ▸ {t.title}</span>}
                  </span>
                  <button
                    className="icon"
                    title="关闭标签"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.key);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="new-tab">
                <button ref={newTabBtn} className="icon" title="新建标签" onClick={() => setShowNewTab(!showNewTab)}>
                  ＋
                </button>
                {/* 挂到 body：标签栏是横向滚动区，菜单放里面会被裁成 36px 高 */}
                {showNewTab && (
                  <PopupMenu anchor={newTabBtn} onClose={() => setShowNewTab(false)}>
                    <div className="new-tab-menu">
                    {hosts.map((h) => (
                      <div key={h.id} className="menu-item new-tab-row">
                        <span className="grow">{h.name}</span>
                        <button className="primary" onClick={() => openTab(h, undefined, "chat")}>
                          对话
                        </button>
                        <button onClick={() => openTab(h)}>终端</button>
                      </div>
                    ))}
                    {hosts.length === 0 && (
                      <div
                        className="menu-item muted"
                        onClick={() => setPage("hosts")}
                      >
                        还没有主机，先到「主机」页添加
                      </div>
                    )}
                    </div>
                  </PopupMenu>
                )}
              </div>
            </div>
            {activeKey && (
              <div className="tab-tools">
                <button className="icon" title={kbd("向右分屏一个终端（Ctrl+Shift+D）")} onClick={() => splitPane(activeKey, "row")}>
                  ‖
                </button>
                <button className="icon" title={kbd("向下分屏一个终端（Ctrl+Shift+E）")} onClick={() => splitPane(activeKey, "col")}>
                  ═
                </button>
                <button className="icon" title="在右侧并排一个新对话" onClick={() => splitPane(activeKey, "row", "chat")}>
                  ＋对话
                </button>
                <div>
                  <button ref={snippetsBtn} className="icon" title="快捷命令" onClick={() => setShowSnippets((s) => !s)}>
                    ⚡
                  </button>
                  {showSnippets && (
                    <PopupMenu anchor={snippetsBtn} onClose={() => setShowSnippets(false)}>
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
                          setPage("settings");
                        }}
                      >
                        管理快捷命令…
                      </div>
                    </PopupMenu>
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
                style={{
                  display: t.key === activeKey ? "flex" : "none",
                  flexDirection: t.dir === "row" ? "row" : "column",
                }}
              >
                {t.panes.map((p, idx) => (
                  // 外层始终包一层：只在多窗格时显示标题栏，包装结构不变，终端不会因为出现标题栏而重建
                  <div key={p.key} className={`pane-slot ${p.key === t.activePane ? "focused" : ""}`}>
                    {t.panes.length > 1 && (
                      <div
                        className="pane-bar"
                        onMouseDown={() => t.activePane !== p.key && patchTab(t.key, { activePane: p.key })}
                        onAuxClick={(e) => e.button === 1 && closePane(t, p.key)}
                        title="中键点击关闭这个窗格"
                      >
                        <span className="pane-bar-kind">{p.kind === "chat" ? "◆ 对话" : "▸ 终端"}</span>
                        <span className="pane-bar-index">#{idx + 1}</span>
                        <div className="grow" />
                        {p.kind !== "chat" && (
                          <>
                            <button className="icon" title={kbd("向右分屏（Ctrl+Shift+D）")} onClick={() => splitPane(t.key, "row")}>
                              ‖
                            </button>
                            <button className="icon" title={kbd("向下分屏（Ctrl+Shift+E）")} onClick={() => splitPane(t.key, "col")}>
                              ═
                            </button>
                          </>
                        )}
                        <button
                          className="icon pane-close"
                          title={p.kind === "chat" ? "关闭这个对话窗格" : kbd("关闭这个终端窗格（Ctrl+Shift+W）")}
                          onClick={() => closePane(t, p.key)}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  {p.kind === "chat" ? (
                    <ChatView
                      key={p.key}
                      host={t.host}
                      visible={page === "workspace" && t.key === activeKey}
                      focused={p.key === t.activePane}
                      onFocus={() => t.activePane !== p.key && patchTab(t.key, { activePane: p.key })}
                      onTitle={(title) => patchTab(t.key, { title })}
                      onAttention={() => (t.key !== activeKey || page !== "workspace") && patchTab(t.key, { attention: true })}
                    />
                  ) : (
                    <TerminalView
                      key={p.key}
                      host={t.host}
                      paneKey={p.key}
                      session={p.session}
                      visible={page === "workspace" && t.key === activeKey}
                      focused={p.key === t.activePane}
                      prefs={prefs.terminal}
                      onTitle={(title) => p.key === t.activePane && patchTab(t.key, { title })}
                      onAttention={() => (t.key !== activeKey || page !== "workspace") && patchTab(t.key, { attention: true })}
                      onFocus={() => t.activePane !== p.key && patchTab(t.key, { activePane: p.key })}
                      onSplit={(dir) => splitPane(t.key, dir)}
                      onClose={() => closePane(t, p.key)}
                      onControl={(ctl) => (ctl ? controls.current.set(p.key, ctl) : controls.current.delete(p.key))}
                    />
                  )}
                  </div>
                ))}
              </div>
            ))}
            {tabs.length === 0 && (
              <div className="placeholder workspace-empty">
                <div>这里会显示你打开的对话和终端</div>
                <button className="primary" onClick={() => setPage("hosts")}>
                  去选一台主机
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      <ModalHost />
      <SshPromptHost />
      <TooltipLayer />
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
      {dialog?.kind === "mcp" && access && (
        <HostMcpDialog
          host={dialog.host}
          settings={access}
          status={mcpStatus.get(dialog.host.id)}
          initialStep={dialog.step}
          onHostSaved={() => reload()}
          onClose={() => setDialog(null)}
          onManage={() => {
            setDialog(null);
            setPage("toolbox");
          }}
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
      {dialog?.kind === "host" && access && (
        <HostForm
          initial={dialog.host}
          hosts={hosts}
          settings={access}
          status={dialog.host ? mcpStatus.get(dialog.host.id) : undefined}
          onCancel={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
      </div>
    </div>
  );
}
