import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { PlanCard, QuestionCard } from "./InteractiveCards";
import { api, ChatSession, errorText, Host, PermissionMode } from "./api";
import {
  addLocalUser,
  ChatState,
  controlRequest,
  emptyState,
  fromHistory,
  itemText,
  PermissionRequest,
  permissionAllow,
  permissionDeny,
  permissionReply,
  reduce,
  system,
  toMarkdown,
  userMessage,
} from "./chatModel";
import { Markdown } from "./Markdown";
import { PermissionCard, ToolCard } from "./ToolCard";

const MODES: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "逐条审批" },
  { value: "acceptEdits", label: "自动接受编辑" },
  { value: "plan", label: "计划模式" },
  { value: "bypassPermissions", label: "跳过所有权限" },
];
const MODELS = ["", "opus", "sonnet", "haiku"];

interface Props {
  host: Host;
  visible: boolean;
  focused: boolean;
  onFocus: () => void;
  onTitle: (title: string) => void;
  onAttention: () => void;
}

interface Completion {
  items: string[];
  index: number;
  /** 替换范围：输入框里 [start, caret) 的文字会被选中项替换 */
  start: number;
  prefix: "/" | "@";
}

const draftKey = (hostId: string, cwd: string) => `ccws.draft.${hostId}.${cwd}`;
const TITLES_KEY = "ccws.sessionTitles";
const SESSION_PREFS_KEY = "ccws.sessionPrefs";

interface SessionPrefs {
  mode: PermissionMode;
  model: string;
}

/** 每个会话上次用的权限模式和模型（只存本机），继续历史会话时恢复 */
function sessionPrefs(): Record<string, SessionPrefs> {
  try {
    return JSON.parse(localStorage.getItem(SESSION_PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function rememberSessionPrefs(sessionId: string, prefs: SessionPrefs) {
  try {
    localStorage.setItem(SESSION_PREFS_KEY, JSON.stringify({ ...sessionPrefs(), [sessionId]: prefs }));
  } catch {
    // 存不下只是下次不恢复
  }
}

/** 用户重命名过的会话标题（只存本机，不改云端会话文件） */
function loadTitles(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TITLES_KEY) ?? "{}");
  } catch {
    return {};
  }
}
const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export function ChatView(props: Props) {
  const { host, visible, focused } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [state, setState] = useState<ChatState>(emptyState);
  const chatIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = state.sessionId;
  // 优先用主机的默认工作目录（每台电脑可以设得不同），没设才用家目录
  const [cwd, setCwd] = useState(host.dir || "~");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [showSessions, setShowSessions] = useState(true);
  const [newCwd, setNewCwd] = useState(host.dir || "~");
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const filesRef = useRef<{ cwd: string; files: string[] } | null>(null);
  /** 下次启动进程时带 --fork-session：在新会话里接着当前历史聊 */
  const forkRef = useRef(false);
  const [titles, setTitles] = useState<Record<string, string>>(loadTitles);
  const [sessionFilter, setSessionFilter] = useState("");
  const [search, setSearch] = useState<{ q: string; index: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showCommands, setShowCommands] = useState(false);
  const [uploading, setUploading] = useState(false);

  // 会话有了 id 后，把当前权限模式和模型记到这个会话上（下次继续时恢复）
  useEffect(() => {
    if (state.sessionId) rememberSessionPrefs(state.sessionId, { mode, model });
  }, [state.sessionId, mode, model]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 进程跟随组件：关标签时结束云端 claude
  useEffect(() => {
    loadSessions();
    return () => {
      if (chatIdRef.current) api.chatStop(chatIdRef.current);
    };
  }, []);

  // 草稿按主机+目录保存，切回来或重启应用都还在
  useEffect(() => {
    try {
      setInput(localStorage.getItem(draftKey(host.id, cwd)) ?? "");
    } catch {
      // 存储不可用时只是没有草稿
    }
  }, [cwd]);
  useEffect(() => {
    try {
      localStorage.setItem(draftKey(host.id, cwd), input);
    } catch {
      // 同上
    }
  }, [input]);

  // 新内容到达时，若用户本来就在底部则跟随滚动
  const nearBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.streaming, state.permissions]);

  useEffect(() => {
    if (visible && focused) inputRef.current?.focus();
  }, [visible, focused]);

  const loadSessions = () =>
    api
      .chatSessions(host.id)
      .then((list) => {
        setSessions(list);
        // 没设默认目录时，「新对话」预填最近一次会话的目录
        if (list[0] && !host.dir && !sessionIdRef.current) setNewCwd(list[0].cwd);
      })
      .catch((e) => setState((s) => system(s, `读取历史会话失败：${errorText(e)}`, "error")));

  /** 用户没在看这个对话时（失焦或切走了）提醒 */
  const notify = (body: string) => {
    const p = propsRef.current;
    if (document.hasFocus() && p.visible && p.focused) return;
    p.onAttention();
    api.notify(p.host.name, body).catch(() => {});
    getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  };

  const onEvent = (e: Record<string, any>) => {
    if (e.type === "exit") chatIdRef.current = null;
    if (e.type === "result") notify(e.is_error ? "Claude 本轮出错" : "Claude 已完成本轮回复");
    if (e.type === "control_request" && e.request?.subtype === "can_use_tool") notify(`Claude 等待审批：${e.request.tool_name}`);
    setState((s) => reduce(s, e));
  };

  const ensureStarted = async () => {
    if (chatIdRef.current) return chatIdRef.current;
    const channel = new Channel<Record<string, any>>();
    channel.onmessage = onEvent;
    const fork = forkRef.current;
    const id = await api.chatStart(
      { hostId: host.id, cwd, resume: sessionIdRef.current, fork, model: model || null, permissionMode: mode },
      channel,
    );
    forkRef.current = false;
    chatIdRef.current = id;
    return id;
  };

  const write = async (message: unknown) => {
    const id = chatIdRef.current;
    if (!id) return;
    await api.chatSend(id, message).catch((e) => setState((s) => system(s, errorText(e), "error")));
  };

  const send = async () => {
    const text = input;
    const imgs = images;
    if (!text.trim() && !imgs.length) return;
    setInput("");
    setImages([]);
    setCompletion(null);
    nearBottom.current = true;
    if (!state.items.length) propsRef.current.onTitle(text.trim().slice(0, 30) || basename(cwd));
    setState((s) => addLocalUser(s, text, imgs));
    try {
      const id = await ensureStarted();
      await api.chatSend(id, userMessage(text, imgs, sessionIdRef.current));
    } catch (e) {
      setState((s) => system({ ...s, running: false }, `发送失败：${errorText(e)}`, "error"));
    }
  };

  const decide = (req: PermissionRequest, decision: "allow" | "always" | "deny") => {
    write(permissionReply(req, decision));
    setState((s) => ({ ...s, permissions: s.permissions.filter((p) => p.requestId !== req.requestId) }));
  };

  const changeMode = (m: PermissionMode) => {
    setMode(m);
    write(controlRequest({ subtype: "set_permission_mode", mode: m }));
  };

  /** 模型输入框失焦时生效；进程未启动时只记下，启动时作为 --model 传入 */
  const lastModel = useRef("");
  const changeModel = (m: string) => {
    if (m === lastModel.current) return;
    lastModel.current = m;
    setModel(m);
    write(controlRequest({ subtype: "set_model", model: m || "default" }));
  };

  /** 切换到另一个会话：先结束当前进程，下次发送时按新会话（或 --resume）启动 */
  const switchTo = (next: ChatState, nextCwd: string) => {
    if (chatIdRef.current) api.chatStop(chatIdRef.current);
    chatIdRef.current = null;
    filesRef.current = null;
    setState(next);
    setCwd(nextCwd);
    propsRef.current.onTitle(basename(nextCwd));
  };

  const resume = async (s: ChatSession) => {
    try {
      const lines = await api.chatHistory(host.id, s.file);
      nearBottom.current = true;
      switchTo({ ...fromHistory(lines), sessionId: s.sessionId }, s.cwd);
      propsRef.current.onTitle(s.title.slice(0, 30));
      const saved = sessionPrefs()[s.sessionId];
      if (saved) {
        setMode(saved.mode);
        setModel(saved.model);
        lastModel.current = saved.model;
      }
    } catch (e) {
      setState((st) => system(st, `读取会话失败：${errorText(e)}`, "error"));
    }
  };

  const removePermission = (req: PermissionRequest) =>
    setState((s) => ({ ...s, permissions: s.permissions.filter((p) => p.requestId !== req.requestId) }));

  const answerQuestion = (req: PermissionRequest, answers: Record<string, string>) => {
    write(permissionAllow(req, { ...req.input, answers }));
    removePermission(req);
  };

  /** 批准计划：先放行 ExitPlanMode（CLI 随之退出计划模式），再切到所选的执行模式 */
  const approvePlan = (req: PermissionRequest, next: "acceptEdits" | "default") => {
    write(permissionAllow(req, req.input));
    removePermission(req);
    changeMode(next);
  };

  const revisePlan = (req: PermissionRequest, feedback: string) => {
    write(permissionDeny(req, `用户希望修改计划：${feedback}`));
    removePermission(req);
  };

  /** 直接发一条文字消息（常用命令按钮用，不动输入框） */
  const sendText = async (text: string) => {
    setShowCommands(false);
    nearBottom.current = true;
    setState((s) => addLocalUser(s, text, []));
    try {
      const id = await ensureStarted();
      await api.chatSend(id, userMessage(text, [], sessionIdRef.current));
    } catch (e) {
      setState((s) => system({ ...s, running: false }, `发送失败：${errorText(e)}`, "error"));
    }
  };

  /** 从本机选文件传到云主机，把远端路径插进输入框，由 Claude 用 Read 读取（支持图片、PDF、文本等） */
  const attachFiles = async () => {
    const picked = await open({ multiple: true });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!paths.length) return;
    setUploading(true);
    try {
      const remote: string[] = [];
      for (const p of paths) remote.push(await api.chatUpload(host.id, p));
      setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}${remote.join(" ")} `);
      inputRef.current?.focus();
    } catch (e) {
      setState((s) => system(s, `上传附件失败：${errorText(e)}`, "error"));
    } finally {
      setUploading(false);
    }
  };

  /** 分叉：结束当前进程，下一条消息在新会话里接着当前历史聊，原会话保持不变 */
  const fork = () => {
    if (chatIdRef.current) api.chatStop(chatIdRef.current);
    chatIdRef.current = null;
    forkRef.current = true;
    setState((s) => system({ ...s, running: false }, "已分叉：下一条消息会在新会话里继续，原会话保持不变"));
  };

  const currentTitle = () =>
    (state.sessionId && (titles[state.sessionId] ?? sessions?.find((s) => s.sessionId === state.sessionId)?.title)) ||
    basename(cwd);

  const exportMarkdown = async () => {
    const title = currentTitle();
    const path = await save({ defaultPath: `${title.slice(0, 40).replace(/[\\/:*?"<>|]/g, "_")}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    await api
      .saveText(path, toMarkdown(state, title))
      .then(() => setState((s) => system(s, `已导出到 ${path}`)))
      .catch((e) => setState((s) => system(s, `导出失败：${errorText(e)}`, "error")));
  };

  /** 正在就地重命名的会话（WebView 里的 prompt() 不可靠，改成列表内输入框） */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const commitRename = () => {
    if (!renaming) return;
    const next = { ...titles };
    if (renaming.value.trim()) next[renaming.id] = renaming.value.trim();
    else delete next[renaming.id];
    setRenaming(null);
    setTitles(next);
    try {
      localStorage.setItem(TITLES_KEY, JSON.stringify(next));
    } catch {
      // 存不下就只在本次运行里生效
    }
  };

  const deleteSession = async (s: ChatSession) => {
    const ok = await ask(`删除云端会话「${titles[s.sessionId] ?? s.title}」？\n会删除云主机上的会话文件，终端里也无法再 --resume，不可恢复。`, {
      title: "删除会话",
      kind: "warning",
    });
    if (!ok) return;
    await api.chatDelete(host.id, s.file).catch((e) => setState((st) => system(st, `删除失败：${errorText(e)}`, "error")));
    if (s.sessionId === state.sessionId) switchTo(emptyState, cwd);
    loadSessions();
  };

  // ---- 对话内搜索 ----

  const matches = useMemo(() => {
    const q = search?.q.trim().toLowerCase();
    if (!q) return [];
    return state.items.filter((it) => itemText(it).toLowerCase().includes(q)).map((it) => it.key);
  }, [search?.q, state.items]);
  const currentMatch = search && matches.length ? matches[search.index % matches.length] : null;

  useEffect(() => {
    if (search) searchInputRef.current?.focus();
  }, [search !== null]);
  useEffect(() => {
    if (!currentMatch) return;
    scrollRef.current?.querySelector(`[data-key="${currentMatch}"]`)?.scrollIntoView({ block: "center" });
  }, [currentMatch]);

  const onPaneKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setSearch((s) => s ?? { q: "", index: 0 });
    }
  };

  // ---- 输入框：/ 命令与 @ 文件补全 ----

  const updateCompletion = async (value: string, caret: number) => {
    const before = value.slice(0, caret);
    if (/^\/\S*$/.test(before)) {
      const q = before.slice(1).toLowerCase();
      const items = state.slashCommands.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 12);
      return setCompletion(items.length ? { items, index: 0, start: 0, prefix: "/" } : null);
    }
    const at = before.match(/(^|\s)@([^\s@]*)$/);
    if (!at) return setCompletion(null);
    if (filesRef.current?.cwd !== cwd) {
      const files = await api.chatFiles(host.id, cwd).catch(() => []);
      filesRef.current = { cwd, files };
    }
    const q = at[2].toLowerCase();
    const items = filesRef.current.files.filter((f) => f.toLowerCase().includes(q)).slice(0, 15);
    setCompletion(items.length ? { items, index: 0, start: caret - at[2].length - 1, prefix: "@" } : null);
  };

  const accept = (c: Completion) => {
    const caret = inputRef.current?.selectionStart ?? input.length;
    const insert = `${c.prefix}${c.items[c.index]} `;
    setInput(input.slice(0, c.start) + insert + input.slice(caret));
    setCompletion(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (completion) {
      const n = completion.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        return setCompletion({ ...completion, index: (completion.index + delta + n) % n });
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        return accept(completion);
      }
      if (e.key === "Escape") return setCompletion(null);
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape" && state.running) write(controlRequest({ subtype: "interrupt" }));
  };

  // 粘贴截图作为图片输入
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile());
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      if (!f) continue;
      const reader = new FileReader();
      reader.onload = () => setImages((imgs) => [...imgs, reader.result as string]);
      reader.readAsDataURL(f);
    }
  };

  const grouped = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase();
    const map = new Map<string, ChatSession[]>();
    for (const s of sessions ?? []) {
      const title = titles[s.sessionId] ?? s.title;
      if (q && !`${title} ${s.cwd}`.toLowerCase().includes(q)) continue;
      map.set(s.cwd, [...(map.get(s.cwd) ?? []), s]);
    }
    return [...map.entries()];
  }, [sessions, sessionFilter, titles]);

  const usage = state.usage;
  const contextPct = usage?.contextWindow ? Math.round((usage.contextUsed / usage.contextWindow) * 100) : null;

  return (
    <div className={`chat-pane terminal-pane ${focused ? "focused" : ""}`} onMouseDown={props.onFocus} onKeyDown={onPaneKeyDown}>
      {showSessions && (
        <aside className="chat-sessions">
          <div className="chat-new">
            <input
              list={`cwds-${host.id}`}
              value={newCwd}
              onChange={(e) => setNewCwd(e.target.value)}
              placeholder="工作目录，如 ~/project"
            />
            <datalist id={`cwds-${host.id}`}>
              {grouped.map(([c]) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <button className="primary" onClick={() => switchTo(emptyState, newCwd.trim() || "~")}>
              新对话
            </button>
          </div>
          <input value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)} placeholder="搜索会话" />
          <div className="chat-session-list">
            {sessions === null && <p className="muted">正在读取历史会话…</p>}
            {sessions?.length === 0 && <p className="muted">还没有历史会话</p>}
            {grouped.map(([c, list]) => (
              <div key={c}>
                <div className="group-head" title={c}>
                  {basename(c)}
                </div>
                {list.map((s) => (
                  <div
                    key={s.sessionId}
                    className={`chat-session ${s.sessionId === state.sessionId ? "active" : ""}`}
                    onClick={() => resume(s)}
                    title={titles[s.sessionId] ?? s.title}
                  >
                    {renaming?.id === s.sessionId ? (
                      <input
                        autoFocus
                        value={renaming.value}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        placeholder="留空恢复原标题（只保存在本机）"
                      />
                    ) : (
                      <div className="chat-session-title">{titles[s.sessionId] ?? s.title}</div>
                    )}
                    <div className="row chat-session-meta">
                      <span className="muted small-text grow">{new Date(s.mtime * 1000).toLocaleString()}</span>
                      <span className="chat-session-actions">
                        <button
                          className="icon"
                          title="重命名"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenaming({ id: s.sessionId, value: titles[s.sessionId] ?? s.title });
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="icon"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(s);
                          }}
                        >
                          🗑
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <button className="link" onClick={loadSessions}>
            刷新
          </button>
        </aside>
      )}

      <div className="chat-main">
        <div className="chat-toolbar">
          <button className="icon" title="显示/隐藏会话列表" onClick={() => setShowSessions(!showSessions)}>
            ☰
          </button>
          <span className="chat-cwd" title={cwd}>
            {cwd}
          </span>
          <select value={mode} onChange={(e) => changeMode(e.target.value as PermissionMode)} title="权限模式">
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <input
            className="chat-model"
            list="chat-models"
            value={model}
            placeholder={state.model ?? "默认模型"}
            onChange={(e) => setModel(e.target.value)}
            onBlur={(e) => changeModel(e.target.value.trim())}
            title="模型（留空为默认）"
          />
          <datalist id="chat-models">
            {MODELS.filter(Boolean).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {usage && (
            <span className="muted chat-usage" title="上下文占用 / 本会话累计花费">
              {contextPct !== null && `上下文 ${contextPct}% · `}${usage.costUsd.toFixed(2)}
            </span>
          )}
          {state.mcpServers.length > 0 && (
            <span
              className={`mcp-badge ${state.mcpServers.some((m) => m.status !== "connected") ? "warn" : ""}`}
              title={state.mcpServers.map((m) => `${m.name}：${m.status === "connected" ? "已连接" : m.status}`).join("\n")}
            >
              MCP {state.mcpServers.filter((m) => m.status === "connected").length}/{state.mcpServers.length}
            </span>
          )}
          <div className="menu-anchor">
            <button className="icon" title="常用命令" onClick={() => setShowCommands(!showCommands)}>
              ⌘
            </button>
            {showCommands && (
              <div className="menu" onMouseLeave={() => setShowCommands(false)}>
                <div className="menu-item" onClick={() => sendText("/compact")}>
                  <span>压缩上下文</span>
                  <code className="muted">/compact</code>
                </div>
                <div
                  className="menu-item"
                  onClick={() => {
                    setShowCommands(false);
                    switchTo(emptyState, cwd);
                  }}
                >
                  <span>清空，开新会话</span>
                  <code className="muted">/clear</code>
                </div>
                {state.slashCommands
                  .filter((c) => c !== "compact" && c !== "clear")
                  .map((c) => (
                    <div
                      key={c}
                      className="menu-item"
                      onClick={() => {
                        setShowCommands(false);
                        setInput(`/${c} `);
                        inputRef.current?.focus();
                      }}
                    >
                      <code>/{c}</code>
                    </div>
                  ))}
                {!state.slashCommands.length && <div className="menu-item muted">发送第一条消息后会列出全部可用命令</div>}
              </div>
            )}
          </div>
          <button className="icon" title="搜索对话（Ctrl+F）" onClick={() => setSearch((s) => s ?? { q: "", index: 0 })}>
            ⌕
          </button>
          <button className="icon" title="导出为 Markdown" disabled={!state.items.length} onClick={exportMarkdown}>
            ⇧
          </button>
          <button className="icon" title="分叉：在新会话里接着聊，原会话不变" disabled={!state.sessionId} onClick={fork}>
            ⑂
          </button>
        </div>
        {search && (
          <div className="chat-search">
            <input
              ref={searchInputRef}
              value={search.q}
              placeholder="搜索对话内容（Enter 下一个，Shift+Enter 上一个，Esc 关闭）"
              onChange={(e) => setSearch({ q: e.target.value, index: 0 })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearch(null);
                if (e.key === "Enter" && matches.length) {
                  const n = matches.length;
                  setSearch({ ...search, index: (search.index + (e.shiftKey ? n - 1 : 1)) % n });
                }
              }}
            />
            <span className="muted small-text">
              {matches.length ? `${(search.index % matches.length) + 1} / ${matches.length}` : search.q ? "无结果" : ""}
            </span>
            <button className="icon" onClick={() => setSearch(null)}>
              ×
            </button>
          </div>
        )}

        <div
          className="chat-messages"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {state.items.length === 0 && !state.running && (
            <div className="placeholder chat-empty">
              在 {host.name} 的 <code>{cwd}</code> 中和 Claude Code 对话
              <div className="muted small-text">Enter 发送 · Shift+Enter 换行 · / 命令 · @ 引用文件 · 可粘贴截图 · Esc 中断</div>
            </div>
          )}
          {state.items.map((item) => {
            const hit = matches.includes(item.key) ? (item.key === currentMatch ? " search-current" : " search-hit") : "";
            if (item.kind === "system") {
              return (
                <div key={item.key} data-key={item.key} className={`chat-system ${item.tone}${hit}`}>
                  {item.text}
                </div>
              );
            }
            return (
              <div key={item.key} data-key={item.key} className={`chat-msg ${item.kind}${hit}`}>
                <div className="msg-actions">
                  <button className="icon" title="复制这条消息" onClick={() => writeText(itemText(item))}>
                    ⧉
                  </button>
                </div>
                {item.blocks.map((b, i) => {
                  if (b.type === "text") return item.kind === "user" ? <div key={i} className="user-text">{b.text}</div> : <Markdown key={i} text={b.text} />;
                  if (b.type === "image") return <img key={i} className="chat-image" src={b.src} />;
                  if (b.type === "thinking")
                    return (
                      <details key={i} className="thinking">
                        <summary>思考过程</summary>
                        <div className="user-text">{b.text}</div>
                      </details>
                    );
                  return <ToolCard key={i} name={b.name} input={b.input} result={state.results[b.id]} steps={state.subs[b.id]} />;
                })}
              </div>
            );
          })}
          {state.streaming && (
            <div className="chat-msg assistant streaming">
              <Markdown text={state.streaming} />
            </div>
          )}
          {state.permissions.map((p) =>
            p.toolName === "AskUserQuestion" ? (
              <QuestionCard
                key={p.requestId}
                req={p}
                onSubmit={(answers) => answerQuestion(p, answers)}
                onCancel={() => decide(p, "deny")}
              />
            ) : p.toolName === "ExitPlanMode" ? (
              <PlanCard key={p.requestId} req={p} onApprove={(m) => approvePlan(p, m)} onRevise={(f) => revisePlan(p, f)} />
            ) : (
              <PermissionCard key={p.requestId} req={p} onDecide={(d) => decide(p, d)} />
            ),
          )}
          {state.running && !state.permissions.length && (
            <div className="chat-working">
              <span className="spinner" /> Claude 正在工作…
              <button className="link" onClick={() => write(controlRequest({ subtype: "interrupt" }))}>
                中断（Esc）
              </button>
            </div>
          )}
        </div>

        <div className="chat-input">
          {images.length > 0 && (
            <div className="chat-attachments">
              {images.map((src, i) => (
                <div key={i} className="chat-thumb">
                  <img src={src} />
                  <button className="icon" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {completion && (
            <div className="menu completion">
              {completion.items.map((c, i) => (
                <div
                  key={c}
                  className={`menu-item ${i === completion.index ? "selected" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept({ ...completion, index: i });
                  }}
                >
                  {completion.prefix}
                  {c}
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            rows={Math.min(10, Math.max(2, input.split("\n").length))}
            placeholder={state.running ? "Claude 正在工作，可以继续输入（会排队）" : "给 Claude 发消息"}
            onChange={(e) => {
              setInput(e.target.value);
              updateCompletion(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="chat-input-actions">
            <button title="从本机选择文件，上传到云主机后把路径插入输入框" disabled={uploading} onClick={attachFiles}>
              {uploading ? "上传中…" : "📎 附件"}
            </button>
            <button className="primary" disabled={!input.trim() && !images.length} onClick={send}>
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
