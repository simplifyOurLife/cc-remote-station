import { useEffect, useRef, useState } from "react";
import { ask, ModalHost } from "./modal";
import { ChatCachePanel, ChatPrefsPanel } from "./ChatCachePanel";
import { listen } from "@tauri-apps/api/event";
import { DeviceSettings } from "./AccessSettings";
import { ActivityPanel, summarize } from "./ActivityPanel";
import { ChatFork, ChatView } from "./ChatView";
import { api, AuditEntry, ChatSession, errorText, forwardState, Host, hostToolbox, McpHostStatus, resumeCommand, Settings } from "./api";
import { HostForm } from "./HostForm";
import { HostsPage } from "./HostsPage";
import { HostMcpDialog, McpTab } from "./HostMcpDialog";
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
import { CommandConfirmHost } from "./CommandConfirm";
import { Launchpad } from "./Launchpad";
import { useOnboarding } from "./onboarding";
import { UpdateDialog, UpdatePanel, UpdateToast, useUpdater } from "./Update";
import { kbd, modKey } from "./platform";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { ContextMenuHost, openMenu } from "./ContextMenu";
import "./App.css";

interface Pane {
  key: string;
  /** 图形对话窗格；缺省为终端 */
  kind?: "chat";
  /** 接回已有 tmux 会话时的会话名 */
  session?: string;
  /** 终端窗格：连上后自动执行的命令 */
  command?: string;
  /** 对话窗格：打开时要继续的历史会话 */
  chatSession?: ChatSession;
  /** 对话窗格：新对话的工作目录（从已有对话里点「新对话」时带过来） */
  chatDir?: string;
  /** 对话窗格：从别的对话分叉过来 */
  chatFork?: ChatFork;
  /** 对话窗格当前的会话 id（同一会话只允许开一处） */
  chatId?: string | null;
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
  /** 主机的 MCP 弹窗：端口转发 / Claude 注册两个标签页 */
  | { kind: "mcp"; host: Host; tab: McpTab };

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
  const [showKeys, setShowKeys] = useState(false);
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
  /** 正在运行（Claude 还在回答）的对话窗格 */
  const [runningPanes, setRunningPanes] = useState<ReadonlySet<string>>(new Set());
  const setPaneRunning = (key: string, on: boolean) =>
    setRunningPanes((s) => {
      if (s.has(key) === on) return s;
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
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

  const setPaneChatId = (tabKey: string, paneKey: string, chatId: string | null) =>
    patchTab(tabKey, (t) => ({ panes: t.panes.map((p) => (p.key === paneKey ? { ...p, chatId } : p)) }));

  /** 从对话的历史列表打开会话：同一主机上别的窗格已开着就切过去；newTab 时开新标签；否则交回原窗格自己继续 */
  const openChatSession = (from: Tab, paneKey: string, s: ChatSession, newTab: boolean): boolean => {
    for (const t of tabs) {
      const p = t.host.id === from.host.id && t.panes.find((x) => x.kind === "chat" && x.chatId === s.sessionId && x.key !== paneKey);
      if (p) {
        activate(t.key);
        patchTab(t.key, { activePane: p.key });
        return true;
      }
    }
    if (!newTab) return false;
    openTab(from.host, undefined, "chat", s);
    return true;
  };

  /**
   * 在终端里用 claude --resume 接着聊对话里的会话（-p 跑出的会话不出现在 claude --resume 的列表里，只能按 id 恢复）。
   * 同一会话不能两个进程同时写：别的对话窗格开着它就先确认、关掉那个窗格；本窗格开着的由 ChatView 自己先放开
   */
  const resumeInTerminal = async (from: Tab, paneKey: string, s: ChatSession) => {
    for (const t of tabs) {
      const p = t.host.id === from.host.id && t.panes.find((x) => x.kind === "chat" && x.chatId === s.sessionId && x.key !== paneKey);
      if (!p) continue;
      if (!(await ask("这个会话正在另一个对话窗格中打开，两边同时写会弄乱记录。关掉那个窗格并在终端中继续？", { title: "在终端中继续", okLabel: "关掉并继续" })))
        return;
      closePane(t, p.key);
    }
    openTab(from.host, undefined, undefined, undefined, resumeCommand(s));
  };

  /** 新开标签并切到工作区；第一次打开时记下，引导第 2 步打勾 */
  const openTab = (
    host: Host,
    session?: string,
    kind?: "chat",
    chatSession?: ChatSession,
    command?: string,
    chatDir?: string,
    chatFork?: ChatFork,
  ) => {
    const pane: Pane = { key: newKey(), session, kind, chatSession, command, chatDir, chatFork };
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

  /** 只留下 keep 里的标签；当前标签被关掉就切到 fallback */
  const keepTabs = (keep: (t: Tab, i: number) => boolean, fallback: string) => {
    setTabs((ts) => {
      const rest = ts.filter(keep);
      if (!rest.some((t) => t.key === activeKey)) setActiveKey(fallback);
      return rest;
    });
  };

  const tabMenu = (e: React.MouseEvent, t: Tab) => {
    const idx = tabs.findIndex((x) => x.key === t.key);
    openMenu(e, [
      { label: "关闭", hint: kbd("Ctrl+F4"), onClick: () => closeTab(t.key) },
      { label: "关闭其他标签", disabled: tabs.length < 2, onClick: () => keepTabs((x) => x.key === t.key, t.key) },
      { label: "关闭右侧标签", disabled: idx === tabs.length - 1, onClick: () => keepTabs((_, i) => i <= idx, t.key) },
      "sep",
      {
        label: t.panes[0].kind === "chat" ? "同主机再开一个对话" : "同主机再开一个终端",
        hint: t.panes[0].kind === "chat" ? kbd("Ctrl+Alt+N") : kbd("Alt+F12"),
        onClick: () => openTab(t.host, undefined, t.panes[0].kind),
      },
    ]);
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

  /** 打开主机的 MCP 弹窗：已有转发就到「Claude 注册」，否则到「端口转发」 */
  const setupClaude = (host: Host) =>
    setDialog({ kind: "mcp", host, tab: host.mcp && hostToolbox(host).length > 0 ? "reg" : "fwd" });

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
  const onboarding = useOnboarding(hosts, hasOpened, access);
  const updater = useUpdater();
  const [showUpdate, setShowUpdate] = useState(false);
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

  // 全局快捷键（捕获阶段，抢在 xterm 之前）：只用 F 键 / Ctrl+Alt / Ctrl+Shift / Alt+方向 这类不占 shell 的组合
  const globalKeys = useRef<(e: KeyboardEvent) => boolean>(() => false);
  globalKeys.current = (e) => {
    const mod = modKey(e);
    const k = e.key.toLowerCase();
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && !e.target.closest(".xterm");
    const step = (d: number) => {
      if (!tabs.length) return;
      const i = tabs.findIndex((t) => t.key === activeKey);
      activate(tabs[(i + d + tabs.length) % tabs.length].key);
      setPage("workspace");
    };
    if ((mod && e.shiftKey && !e.altKey && k === "a") || e.key === "F1") setShowKeys(true);
    else if (mod && e.altKey && k === "s") setPage("settings");
    else if (e.ctrlKey && e.key === "Tab") step(e.shiftKey ? -1 : 1);
    else if (e.altKey && !mod && !e.shiftKey && !typing && (e.key === "ArrowRight" || e.key === "ArrowLeft")) step(e.key === "ArrowRight" ? 1 : -1);
    else if (mod && e.key === "F4" && activeKey) closeTab(activeKey);
    else if (e.altKey && e.key === "F12" && activeTab) openTab(activeTab.host);
    // 对话窗格里的 Ctrl+Alt+N 由对话自己处理（换新会话），这里只管其它地方：开新对话标签
    else if (mod && e.altKey && k === "n" && activeTab?.host.claude && !(e.target instanceof Element && e.target.closest(".chat-pane")))
      openTab(activeTab.host, undefined, "chat");
    else return false;
    return true;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (globalKeys.current(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const crumbs = [
    "cc-remote-station",
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
        <div className="rail-brand" title={railCollapsed ? "cc-remote-station · 云端 Claude Code 工作台" : undefined}>
          <Logo />
          <div className="rail-brand-text">
            <span className="brand">cc-remote-station</span>
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
            {!onboarding.hidden && onboarding.done < onboarding.total && (
              <span className="rail-count rail-onboard" title="上手清单进度；工作区没有标签时显示清单">
                上手 {onboarding.done}/{onboarding.total}
              </span>
            )}
            {attention && <span className="tab-dot" title="有后台标签在等你" />}
          </>,
        )}
        {navItem("toolbox", "▦", "MCP 工具箱", mcpError && <span className="mcp-dot error" title="有主机的端口映射建立失败" />)}
        {navItem(
          "settings",
          "⚙",
          "设置",
          updater.info && (
            <span
              className="rail-count rail-update"
              title={`有新版本 v${updater.info.version}，点击查看`}
              onClick={(e) => {
                e.stopPropagation();
                setShowUpdate(true);
              }}
            >
              新版本
            </span>
          ),
        )}
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
            onAdd={() => setDialog({ kind: "host", host: null })}
            onImport={() => setDialog({ kind: "import" })}
            onEdit={(h) => setDialog({ kind: "host", host: h })}
            onDelete={remove}
            onTerminal={(h) => openTab(h)}
            onChat={(h) => openTab(h, undefined, "chat")}
            onSessions={(h) => setDialog({ kind: "tmux", host: h })}
            onSetupClaude={setupClaude}
            onTools={(h) => setDialog({ kind: "mcp", host: h, tab: "fwd" })}
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
                              <b>{h.name}</b>{" "}
                              {!st && (
                                <span className="muted">
                                  {h.mcpAutostart ? "正在启动" : "未连接：打开它的对话或终端后建立映射（可在「MCP 工具」里改成打开应用就建立）"}
                                </span>
                              )}
                              {st && !st.mode && <span className="muted">{st.note ?? "正在连接"}</span>}
                              {st?.mode && <span className="fwd-via">{st.mode === "own" ? "独立连接" : "借用终端连接"}</span>}
                              {st?.mode && (
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
                <p className="muted">在线升级、对话偏好、会话缓存，以及终端的外观和快捷命令（保存后立即作用到所有已打开的终端）。</p>
              </div>
            </header>
            <UpdatePanel updater={updater} onShow={() => setShowUpdate(true)} />
            <ChatPrefsPanel />
            <ChatCachePanel />
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
                  className={`tab ${t.key === activeKey ? "active" : ""} ${t.panes.some((p) => runningPanes.has(p.key)) ? "running" : ""}`}
                  title={`${t.host.name}${t.title ? ` ▸ ${t.title}` : ""}${t.panes.some((p) => runningPanes.has(p.key)) ? "\nClaude 正在回答" : ""}\n中键点击关闭`}
                  onClick={() => activate(t.key)}
                  // 中键关闭（和浏览器一致）；mousedown 拦掉中键自动滚动
                  onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                  onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
                  onContextMenu={(e) => tabMenu(e, t)}
                >
                  {t.attention && <span className="tab-dot" />}
                  {t.panes.some((p) => runningPanes.has(p.key)) ? (
                    <span className="tab-kind running">
                      <span className="spinner" />
                    </span>
                  ) : (
                    <span className="tab-kind">{t.panes[0].kind === "chat" ? "对话" : "终端"}</span>
                  )}
                  <span className="tab-title">
                    {t.title || t.host.name}
                    {t.panes.length > 1 && <span className="muted"> [{t.panes.length}]</span>}
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
                        {h.claude && (
                          <button className="primary" onClick={() => openTab(h, undefined, "chat")}>
                            对话
                          </button>
                        )}
                        <button className={h.claude ? "" : "primary"} onClick={() => openTab(h)}>
                          终端
                        </button>
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
                <button className="act-btn" title={kbd("向右分屏一个终端（Ctrl+Shift+D）")} onClick={() => splitPane(activeKey, "row")}>
                  <i>‖</i>
                  <span>右分屏</span>
                </button>
                <button className="act-btn" title={kbd("向下分屏一个终端（Ctrl+Shift+E）")} onClick={() => splitPane(activeKey, "col")}>
                  <i>═</i>
                  <span>下分屏</span>
                </button>
                {activeTab?.host.claude && (
                  <button className="act-btn" title="在右侧并排一个新对话" onClick={() => splitPane(activeKey, "row", "chat")}>
                    <i>＋</i>
                    <span>并排对话</span>
                  </button>
                )}
                <div>
                  <button
                    ref={snippetsBtn}
                    className={`act-btn${showSnippets ? " on" : ""}`}
                    title="快捷命令：一键发送到当前终端（在「设置」里编辑）"
                    onClick={() => setShowSnippets((s) => !s)}
                  >
                    <i>⚡</i>
                    <span>快捷命令</span>
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
                      onRunning={(on) => setPaneRunning(p.key, on)}
                      initialSession={p.chatSession}
                      initialDir={p.chatDir}
                      onNewChat={(dir) => openTab(t.host, undefined, "chat", undefined, undefined, dir)}
                      initialFork={p.chatFork}
                      onFork={(f) => openTab(t.host, undefined, "chat", undefined, undefined, undefined, f)}
                      onSession={(chatId) => setPaneChatId(t.key, p.key, chatId)}
                      onOpenSession={(s, newTab) => openChatSession(t, p.key, s, newTab)}
                      onResumeInTerminal={(s) => resumeInTerminal(t, p.key, s)}
                    />
                  ) : (
                    <TerminalView
                      key={p.key}
                      host={t.host}
                      paneKey={p.key}
                      session={p.session}
                      command={p.command}
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
              <div className="placeholder launchpad-bg">
                <Launchpad
                  hosts={hosts}
                  mcpStatus={mcpStatus}
                  onboarding={onboarding}
                  onImport={() => setDialog({ kind: "import" })}
                  onTerminal={(h) => openTab(h)}
                  onChat={(h, s) => openTab(h, undefined, "chat", s)}
                  onAllHosts={() => setPage("hosts")}
                  onAddHost={() => setDialog({ kind: "host", host: null })}
                  onToolbox={() => setPage("toolbox")}
                  onShortcuts={() => setShowKeys(true)}
                />
              </div>
            )}
          </div>
        </div>
      </main>

      <ModalHost />
      <SshPromptHost />
      <CommandConfirmHost />
      {!showUpdate && updater.info && <UpdateToast info={updater.info} onShow={() => setShowUpdate(true)} />}
      {showUpdate && updater.info && <UpdateDialog info={updater.info} openTabs={tabs.length} onClose={() => setShowUpdate(false)} />}
      <TooltipLayer />
      <ContextMenuHost />
      {showKeys && <ShortcutsPanel onClose={() => setShowKeys(false)} />}
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
          initialTab={dialog.tab}
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
    </div>
  );
}
