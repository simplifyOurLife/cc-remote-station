import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loading } from "./Loading";
import { ConnectScreen } from "./ConnectScreen";
import { Logo } from "./Logo";
import { UserAvatar } from "./UserAvatar";
import { hostDateTime, hostShortTime, HostTz, tzLabel, useHostTz } from "./hostTime";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ask } from "./modal";
import { PlanCard, QuestionCard } from "./InteractiveCards";
import { api, ChatSession, errorText, Host, PermissionMode } from "./api";
import {
  addLocalUser,
  ChatState,
  controlRequest,
  emptyState,
  fromHistory,
  initializeRequest,
  Item,
  itemText,
  lastUserAt,
  MCP_ACTION_PREFIX,
  mcpActionRequest,
  mcpStatusRequest,
  PermissionRequest,
  SlashCommand,
  permissionAllow,
  permissionDeny,
  permissionReply,
  reduce,
  system,
  toMarkdown,
  userMessage,
} from "./chatModel";
import { Markdown } from "./Markdown";
import { McpPanel } from "./McpPanel";
import { Combo } from "./Select";
import { PopupMenu } from "./PopupMenu";
import { ChatMinimap } from "./ChatMinimap";
import { openMenu, selectedText } from "./ContextMenu";
import { copyText } from "./copy";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChatStatus, nextMode } from "./ChatStatus";
import { PermissionCard, ToolCard } from "./ToolCard";
import { kbd, modKey } from "./platform";
import { coldPct, observeQuota, pctText } from "./quota";

/**
 * 缓存有效期：超过就按完整上下文重新计费。订阅账号下 CLI 和 stream-json 模式写的都是 1 小时缓存
 * （会话文件 usage.cache_creation 里只有 ephemeral_1h）。以前按 5 分钟算，闲置 5–60 分钟会误报「缓存已过期」，
 * 提醒多了就没人看，真冷启动反而被点过去
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** 缓存已过期且上下文超过这个时，发消息前先拦下确认 */
const COLD_WARN_TOKENS = 50_000;
/** 超过这个的大会话冷启动：提醒卡改成醒目的红色（一次重写约等于几十轮普通对话） */
const COLD_HEAVY_TOKENS = 150_000;
/** 当前会话上下文超过这个、缓存还在时建议趁热压缩 */
const HOT_COMPACT_TOKENS = 200_000;
/** 历史会话每批渲染的消息数 */
const PAGE = 60;
const MODELS = ["", "opus", "sonnet", "haiku"];
const SESSIONS_KEY = "ccws.chatSessionsOpen";

/** 历史会话列表的本地缓存（按主机 + 目录），打开时先显示它 */
const listCacheKey = (hostId: string, dir: string | null) => `ccws.sessionList.${hostId}.${dir ?? "*"}`;
function cachedSessions(hostId: string, dir: string | null): ChatSession[] | null {
  try {
    return JSON.parse(localStorage.getItem(listCacheKey(hostId, dir)) ?? "null");
  } catch {
    return null;
  }
}
function cacheSessions(hostId: string, dir: string | null, list: ChatSession[]) {
  try {
    localStorage.setItem(listCacheKey(hostId, dir), JSON.stringify(list));
  } catch {
    // 存不下就不缓存
  }
}

/** Claude 回复上的角色标：小机器人 + CLAUDE */
function ClaudeRole() {
  return (
    <div className="msg-role" aria-hidden="true">
      <Logo size={18} className="logo-role" />
      CLAUDE
    </div>
  );
}

/** 闲置多久：8 分钟 / 3 小时 / 2 天 */
function idleText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} 小时` : `${Math.floor(h / 24)} 天`;
}

/** 耗时：23s / 1m23s / 1h02m */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** 正在工作时的实时计时，每秒走一次 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="elapsed">{duration(now - since)}</span>;
}

/** 你的消息上的角色标：发送时间 + 你 + 兜帽黑客头像 */
function UserRole({ at, tz }: { at?: number; tz: HostTz | null }) {
  return (
    <div className="msg-role user-role">
      {at && (
        <span className="msg-time" title={hostDateTime(at / 1000, tz)}>
          {hostShortTime(at / 1000, tz)}
        </span>
      )}
      你
      <UserAvatar size={18} />
    </div>
  );
}

/** 记在本机的用量快照（按主机）：额度只在回复后才报告，先显示上次的 */
interface SavedUsage {
  rateLimits: ChatState["rateLimits"];
  contextWindow: number | null;
  /** 上次新会话首轮的上下文大小（系统提示 + 工具 + CLAUDE.md），新会话还没回复时拿来预估 */
  baseContext: number | null;
}
const usageKey = (hostId: string) => `ccws.usage.${hostId}`;
function loadUsage(hostId: string): SavedUsage {
  try {
    const v = JSON.parse(localStorage.getItem(usageKey(hostId)) ?? "null");
    if (v && typeof v === "object") return { rateLimits: v.rateLimits ?? {}, contextWindow: v.contextWindow ?? null, baseContext: v.baseContext ?? null };
  } catch {
    // 读不到就当没有
  }
  return { rateLimits: {}, contextWindow: null, baseContext: null };
}
function saveUsage(hostId: string, u: SavedUsage) {
  try {
    localStorage.setItem(usageKey(hostId), JSON.stringify(u));
  } catch {
    // 存不下只是下次打开先显示空
  }
}
function withSavedUsage(s: ChatState, u: Omit<SavedUsage, "baseContext">): ChatState {
  return { ...s, rateLimits: u.rateLimits, usage: { ...s.usage, contextWindow: s.usage.contextWindow ?? u.contextWindow } };
}

/** 本地实现的斜杠命令：CLI 的 -p 模式不提供这些（它们依赖交互界面），发送前在本地拦截执行 */
const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "resume", description: "本地 · 选择一个历史会话继续，可跟关键词过滤" },
  { name: "continue", description: "本地 · 继续当前目录最近的一次会话" },
  { name: "clear", description: "本地 · 清空，开新会话" },
  { name: "fork", description: "本地 · 分叉：在新会话里接着聊，原会话不变" },
  { name: "export", description: "本地 · 导出当前对话为 Markdown" },
  { name: "mcp", description: "本地 · 查看 MCP 服务器状态和工具，可重连、启停" },
];

interface Props {
  host: Host;
  visible: boolean;
  focused: boolean;
  onFocus: () => void;
  onTitle: (title: string) => void;
  onAttention: () => void;
  /** 打开时直接继续的历史会话（「新标签打开」） */
  initialSession?: ChatSession;
  /** 当前会话 id 变了：上报给标签页，用来发现同一会话已在别处打开 */
  onSession: (sessionId: string | null) => void;
  /** 打开历史会话：已在别的窗格打开就切过去、newTab 时开新标签，这两种返回 true；返回 false 则在本窗格继续 */
  onOpenSession: (s: ChatSession, newTab: boolean) => boolean;
}

interface Completion {
  items: string[];
  /** 与 items 一一对应的说明（斜杠命令有，文件没有） */
  hints?: (string | undefined)[];
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

/** 各对话窗格的搜索高亮：CSS.highlights 是全局注册表，合并后统一写入两个名字 */
const paneHighlights = new Map<string, { hits: Range[]; cur: Range[] }>();
function setHighlights(id: string, hits: Range[], cur: Range[]) {
  const reg = (CSS as any).highlights;
  if (!reg) return;
  if (hits.length || cur.length) paneHighlights.set(id, { hits, cur });
  else paneHighlights.delete(id);
  const all = [...paneHighlights.values()];
  reg.set("chat-hit", new Highlight(...all.flatMap((h) => h.hits)));
  reg.set("chat-current", new Highlight(...all.flatMap((h) => h.cur)));
}

const CHAT_WIDTH_KEY = "ccws.chatWidth";
const CHAT_WIDTH_DEFAULT = 900;
const CHAT_WIDTH_MIN = 600;

/** 对话列宽度（px），0 表示铺满；所有会话共用 */
function savedChatWidth(): number {
  try {
    const v = Number(localStorage.getItem(CHAT_WIDTH_KEY) ?? CHAT_WIDTH_DEFAULT);
    return v === 0 || v >= CHAT_WIDTH_MIN ? v : CHAT_WIDTH_DEFAULT;
  } catch {
    return CHAT_WIDTH_DEFAULT;
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
  // 额度和上下文窗口先用上次在这台主机上记下的，新对话一打开就有数
  const [state, setState] = useState<ChatState>(() => withSavedUsage(emptyState, loadUsage(host.id)));
  const [baseContext, setBaseContext] = useState(() => loadUsage(host.id).baseContext);
  /** 当前是全新会话、还没拿到过上下文大小 */
  const freshRef = useRef(true);
  /** 云主机时区：历史会话、额度重置等时间按 Claude 运行的地方显示 */
  const tz = useHostTz(host.id);
  const chatIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = state.sessionId;
  // 优先用主机的默认工作目录（每台电脑可以设得不同），没设才用家目录
  const [cwd, setCwd] = useState(host.dir || "~");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  // 启动进程时读 ref：切换会话后立刻预热，此时 state 还没刷新
  const cwdRef = useRef(cwd);
  const modeRef = useRef(mode);
  const modelRef = useRef(model);
  cwdRef.current = cwd;
  modeRef.current = mode;
  modelRef.current = model;
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  /** 刚打开、云端 claude 还没响应时显示启动画面 */
  const [booting, setBooting] = useState(true);
  /** 左侧会话列表展开/收起（记在本机，所有对话共用） */
  const [showSessions, setShowSessionsState] = useState(() => {
    try {
      return localStorage.getItem(SESSIONS_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const setShowSessions = (show: boolean) => {
    setShowSessionsState(show);
    try {
      localStorage.setItem(SESSIONS_KEY, show ? "1" : "0");
    } catch {
      // 存不下只是下次打开恢复展开
    }
  };
  /** 左侧的工作目录：只列这个目录的历史会话，「新对话」也在这里开始；allDirs 时列全部目录 */
  const [listDir, setListDir] = useState(host.dir || "~");
  const [allDirs, setAllDirs] = useState(false);
  /** 云端 Claude 最近用过的目录（目录下拉的建议）；还在读为 null */
  const [recentDirs, setRecentDirs] = useState<string[] | null>(null);
  /** 最近一次读取的条件，刷新、删除后按它重读；序号用来丢弃过时的响应 */
  const listQuery = useRef<{ dir: string | null; seq: number }>({ dir: host.dir || "~", seq: 0 });
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
  /** /resume 的会话选择框：q 为过滤关键词 */
  const [picker, setPicker] = useState<{ q: string; index: number } | null>(null);
  const [showMcp, setShowMcp] = useState(false);
  /** 正在重连/启停的 MCP 服务器 */
  const [mcpPending, setMcpPending] = useState<string | null>(null);

  // 会话有了 id 后，把当前权限模式和模型记到这个会话上（下次继续时恢复）
  useEffect(() => {
    if (state.sessionId) rememberSessionPrefs(state.sessionId, { mode, model });
  }, [state.sessionId, mode, model]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = useState(savedChatWidth);
  const [resizing, setResizing] = useState(false);

  // 拖对话列两侧的把手改宽度：以列中心对称伸缩，拖到最宽即铺满
  function startResize(e: React.PointerEvent<HTMLDivElement>) {
    const stage = e.currentTarget.parentElement!;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    let width = chatWidth;
    const move = (ev: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      const avail = rect.width - 60; // .chat-messages 左右 padding 44 + 给角色标外伸留的 16
      const w = Math.round(2 * Math.abs(ev.clientX - (rect.left + rect.width / 2)));
      width = w >= avail - 4 ? 0 : Math.max(Math.min(CHAT_WIDTH_MIN, avail), w);
      setChatWidth(width);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setResizing(false);
      try {
        localStorage.setItem(CHAT_WIDTH_KEY, String(width));
      } catch {
        // 存不下只是下次恢复默认
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function resetWidth() {
    setChatWidth(CHAT_WIDTH_DEFAULT);
    try {
      localStorage.removeItem(CHAT_WIDTH_KEY);
    } catch {
      // 忽略
    }
  }
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 输入框按内容实际高度自动长高（长段文字折行也算），最多约 10 行，再多就滚动
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * 10 + 20)}px`;
  }, [input]);

  // 打开即预热：后台启动云端 claude 并拿命令列表；关标签时结束它
  useEffect(() => {
    loadSessions(listQuery.current.dir);
    api
      .chatDirs(host.id)
      .then(setRecentDirs)
      .catch(() => setRecentDirs([]));
    if (props.initialSession) resume(props.initialSession);
    else warm();
    return () => {
      if (chatIdRef.current) api.chatStop(chatIdRef.current);
    };
  }, []);

  useEffect(() => propsRef.current.onSession(state.sessionId), [state.sessionId]);

  // 额度和上下文窗口一有更新就记下来（按主机）
  useEffect(() => {
    saveUsage(host.id, { rateLimits: state.rateLimits, contextWindow: state.usage.contextWindow, baseContext });
  }, [state.rateLimits, state.usage.contextWindow, baseContext]);

  // 新会话第一次拿到上下文大小：记下来，以后新会话还没回复时用它预估
  useEffect(() => {
    if (freshRef.current && state.usage.contextUsed !== null) {
      freshRef.current = false;
      setBaseContext(state.usage.contextUsed);
    }
  }, [state.usage.contextUsed]);

  // 启动画面兜底：云端迟迟没有任何响应也不能一直挡着对话界面
  useEffect(() => {
    const timer = setTimeout(() => setBooting(false), 45000);
    return () => clearTimeout(timer);
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
  /** 用户翻到上面时又有了新内容：显示「跳到最新」 */
  const [behind, setBehind] = useState(false);
  const toBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = true;
    setBehind(false);
    el.scrollTop = el.scrollHeight;
  };
  // 内容高度的任何变化都要跟：不只是新消息，还有工具结果、子代理步骤、Markdown/图片渲染完撑高。
  // 只盯 React 状态会漏掉这些，落后超过阈值后就再也不跟了
  useEffect(() => {
    const el = scrollRef.current!;
    const follow = () => {
      if (earlierLoaded.current) earlierLoaded.current = false;
      else if (nearBottom.current) el.scrollTop = el.scrollHeight;
      else setBehind(true);
    };
    const mo = new MutationObserver(follow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("load", follow, true);
    return () => {
      mo.disconnect();
      el.removeEventListener("load", follow, true);
    };
  }, []);
  // 等你审批/回答的卡片一定要看到，翻到上面了也拉回来
  const permCount = state.permissions.length;
  const prevPermCount = useRef(0);
  useEffect(() => {
    if (permCount > prevPermCount.current) toBottom();
    prevPermCount.current = permCount;
  }, [permCount]);
  // 隐藏的标签页里滚不动，切回来时补一次
  useEffect(() => {
    if (visible && nearBottom.current) toBottom();
  }, [visible]);

  useEffect(() => {
    if (visible && focused) inputRef.current?.focus();
  }, [visible, focused]);

  /** 读历史会话：dir 为 null 时读全部目录；不传则按上次的条件重读 */
  const loadSessions = (dir: string | null = listQuery.current.dir) => {
    const seq = listQuery.current.seq + 1;
    listQuery.current = { dir, seq };
    // 先显示上次的列表，云端结果回来再替换（高延迟链路上要等好几个来回）
    setSessions(cachedSessions(host.id, dir));
    api
      .chatSessions(host.id, dir)
      .then((list) => {
        if (listQuery.current.seq !== seq) return;
        setSessions(list);
        cacheSessions(host.id, dir, list);
      })
      .catch((e) => {
        if (listQuery.current.seq !== seq) return;
        setSessions([]);
        setState((s) => system(s, `读取历史会话失败：${errorText(e)}`, "error"));
      });
  };

  /** 左侧切换目录：只看这个目录的会话 */
  const showDir = (dir: string) => {
    const d = dir.trim() || "~";
    setListDir(d);
    setAllDirs(false);
    if (d !== listQuery.current.dir) loadSessions(d);
  };

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
    // 云端 claude 有了第一次响应（握手回复 / init / 退出），启动画面就可以收起了
    if (e.type === "control_response" || e.type === "system" || e.type === "exit") setBooting(false);
    if (e.type === "result") notify(e.is_error ? "Claude 本轮出错" : "Claude 已完成本轮回复");
    if (e.type === "control_request" && e.request?.subtype === "can_use_tool") notify(`Claude 等待审批：${e.request.tool_name}`);
    // MCP 重连/启停有了结果：成功就重新查状态，失败由 reduce 在对话里提示
    if (e.type === "control_response" && String(e.response?.request_id ?? "").startsWith(MCP_ACTION_PREFIX)) {
      setMcpPending(null);
      if (e.response.subtype !== "error") write(mcpStatusRequest());
    }
    observeQuota(e);
    setState((s) => reduce(s, e));
  };

  const ensureStarted = async () => {
    if (chatIdRef.current) return chatIdRef.current;
    const channel = new Channel<Record<string, any>>();
    channel.onmessage = onEvent;
    const fork = forkRef.current;
    forkRef.current = false;
    const id = await api.chatStart(
      {
        hostId: host.id,
        cwd: cwdRef.current,
        resume: sessionIdRef.current,
        fork,
        model: modelRef.current || null,
        permissionMode: modeRef.current,
      },
      channel,
    );
    chatIdRef.current = id;
    // 和 Agent SDK 一样先发 initialize：不用等第一条消息就能拿到命令列表和可选模型
    await api.chatSend(id, initializeRequest());
    return id;
  };

  /** 预热：后台启动进程。启动钩子提前跑完，第一条消息不用再等冷启动 */
  const warm = () =>
    ensureStarted().catch((e) => {
      setBooting(false);
      setState((s) => system(s, `启动云端 claude 失败：${errorText(e)}`, "error"));
    });

  const write = async (message: unknown) => {
    const id = chatIdRef.current;
    if (!id) return;
    await api.chatSend(id, message).catch((e) => setState((s) => system(s, errorText(e), "error")));
  };

  /** 本地命令在这里执行，返回 true 表示已处理、不再发给云端 */
  const runLocalCommand = (text: string): boolean => {
    const m = text.trim().match(/^\/(\w+)\s*([\s\S]*)$/);
    if (!m || !LOCAL_COMMANDS.some((c) => c.name === m[1])) return false;
    const arg = m[2].trim();
    if (m[1] === "resume") {
      setPicker({ q: arg, index: 0 });
      if (sessions === null) loadSessions();
    } else if (m[1] === "continue") {
      // 优先当前目录最近的会话，没有就取全部里最近的（列表已按时间倒序）
      const latest = sessions?.find((s) => s.cwd === cwd) ?? sessions?.[0];
      if (latest) openSession(latest, false);
      else setState((s) => system(s, "没有可以继续的历史会话"));
    } else if (m[1] === "clear") {
      switchTo(emptyState, cwd);
    } else if (m[1] === "fork") {
      if (state.sessionId) fork();
      else setState((s) => system(s, "当前还没有会话，发一条消息后再分叉"));
    } else if (m[1] === "export") {
      exportMarkdown();
    } else if (m[1] === "mcp") {
      openMcp();
    }
    return true;
  };

  const openMcp = () => {
    setShowMcp(true);
    ensureStarted()
      .then(() => write(mcpStatusRequest()))
      .catch((e) => setState((s) => system(s, `启动云端 claude 失败：${errorText(e)}`, "error")));
  };

  const mcpAction = (name: string, enabled?: boolean) => {
    setMcpPending(name);
    write(mcpActionRequest(name, enabled));
  };

  const send = async () => {
    const text = input;
    const imgs = images;
    if (!text.trim() && !imgs.length) return;
    if (!imgs.length && runLocalCommand(text)) {
      setInput("");
      setCompletion(null);
      return;
    }
    // 缓存冷了：第一次按发送只拦下提醒（消息留在输入框），再按一次才真发
    if (coldTokens() !== null) {
      if (!coldArmed) return setColdArmed(true);
      setColdAck(state.lastActive);
    }
    setColdArmed(false);
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

  /** 切换到另一个会话：结束当前进程，按新会话（或 --resume）立刻重新预热 */
  const switchTo = (next: ChatState, nextCwd: string) => {
    if (chatIdRef.current) api.chatStop(chatIdRef.current);
    chatIdRef.current = null;
    filesRef.current = null;
    sessionIdRef.current = next.sessionId;
    cwdRef.current = nextCwd;
    freshRef.current = !next.sessionId && !next.items.length;
    setShownFrom(0);
    setColdArmed(false);
    // 额度是账号级的、窗口大小跟模型走，换会话都不清空
    setState((s) => withSavedUsage(next, { rateLimits: s.rateLimits, contextWindow: s.usage.contextWindow }));
    setCwd(nextCwd);
    propsRef.current.onTitle(basename(nextCwd));
    warm();
  };

  /** 正在载入的历史会话（显示载入动画）；序号用来丢掉被后一次点击取代的结果 */
  const [loadingSession, setLoadingSession] = useState<ChatSession | null>(null);
  const commandsBtn = useRef<HTMLButtonElement>(null);
  /** 从第几条开始渲染：大会话先只画最近 PAGE 条，往上滚到顶或点按钮再加载更早的 */
  const [shownFrom, setShownFrom] = useState(0);
  /** 加载更早消息前的内容高度：渲染后按增量补上 scrollTop，画面不跳 */
  const heightBeforeLoad = useRef<number | null>(null);
  /** 刚在顶部补上了更早的消息：这次内容变化不算「有新内容」 */
  const earlierLoaded = useRef(false);
  const loadEarlier = () => {
    if (shownFrom === 0 || heightBeforeLoad.current !== null) return;
    heightBeforeLoad.current = scrollRef.current!.scrollHeight;
    earlierLoaded.current = true;
    setShownFrom((n) => Math.max(0, n - PAGE));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && heightBeforeLoad.current !== null) el.scrollTop += el.scrollHeight - heightBeforeLoad.current;
    heightBeforeLoad.current = null;
  }, [shownFrom]);
  // 冷启动提醒：不管是刚载入的历史会话、还是开着的标签闲置了很久，只看「发送这一刻」缓存是否已过期。
  // coldAck：用户已确认过的那次 lastActive（确认后不再拦）；coldArmed：已拦过一次，再按发送就放行
  const [coldAck, setColdAck] = useState<number | null>(null);
  const [coldArmed, setColdArmed] = useState(false);
  // 闲置时没有任何重新渲染，定时刷一下，让提醒在缓存过期后自己出现
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  /** 现在发消息会冷启动计费时，返回会重新写入缓存的上下文大小；否则 null */
  const coldTokens = (): number | null => {
    const ctx = state.usage.contextUsed ?? 0;
    const at = state.lastActive;
    if (state.running || !at || coldAck === at || ctx <= COLD_WARN_TOKENS) return null;
    return Date.now() - at > CACHE_TTL_MS ? ctx : null;
  };
  const resumeSeq = useRef(0);

  const resume = async (s: ChatSession) => {
    const seq = ++resumeSeq.current;
    setLoadingSession(s);
    try {
      const t0 = performance.now();
      const lines = await api.chatHistory(host.id, s.file);
      if (seq !== resumeSeq.current) return;
      const t1 = performance.now();
      nearBottom.current = true;
      // 先恢复这个会话上次的权限模式和模型，再切换（预热时就按它们启动）
      const saved = sessionPrefs()[s.sessionId];
      if (saved) {
        setMode(saved.mode);
        setModel(saved.model);
        modeRef.current = saved.mode;
        modelRef.current = saved.model;
        lastModel.current = saved.model;
      }
      const hist = fromHistory(lines);
      const t2 = performance.now();
      switchTo({ ...hist, sessionId: s.sessionId }, s.cwd);
      setShownFrom(Math.max(0, hist.items.length - PAGE));
      // 耗时分段：读取 = SSH 传输 + 解压 + Rust 解析 + IPC；渲染等下一帧画完再记
      requestAnimationFrame(() =>
        setTimeout(() =>
          console.info(
            `[历史会话] ${s.title.slice(0, 20)}：读取 ${Math.round(t1 - t0)}ms（${lines.length} 行）· 解析 ${Math.round(t2 - t1)}ms · 渲染 ${Math.round(performance.now() - t2)}ms（${hist.items.length} 条，先渲染最近 ${Math.min(PAGE, hist.items.length)} 条）`,
          ),
        ),
      );
      propsRef.current.onTitle(s.title.slice(0, 30));
    } catch (e) {
      if (seq === resumeSeq.current) setState((st) => system(st, `读取会话失败：${errorText(e)}`, "error"));
      // 新标签首次载入失败就不会再唤醒，收掉唤醒屏让人看到报错
      if (s === props.initialSession) setBooting(false);
    } finally {
      if (seq === resumeSeq.current) setLoadingSession(null);
    }
  };

  /** 同一会话不能两个进程同时写：已在别处打开就切过去，否则按 newTab 开新标签或在本窗格继续 */
  const openSession = (s: ChatSession, newTab: boolean) => {
    if (!propsRef.current.onOpenSession(s, newTab)) resume(s);
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
    // 直接点的命令（如提醒卡上的 /compact）算用户已知情
    if (coldTokens() !== null) setColdAck(state.lastActive);
    setColdArmed(false);
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
    setState((s) => system({ ...s, running: false }, "已分叉：接下来在新会话里继续，原会话保持不变"));
    warm();
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
      okLabel: "删除",
    });
    if (!ok) return;
    // 本地直接收起这一行，不重扫列表（重扫要把上百个会话文件再读一遍，很慢还会闪）
    setRemoving((r) => new Set(r).add(s.sessionId));
    const anim = new Promise((r) => setTimeout(r, 260));
    try {
      await api.chatDelete(host.id, s.file);
    } catch (e) {
      setRemoving((r) => {
        const n = new Set(r);
        n.delete(s.sessionId);
        return n;
      });
      setState((st) => system(st, `删除失败：${errorText(e)}`, "error"));
      return;
    }
    if (s.sessionId === state.sessionId) switchTo(emptyState, cwd);
    await anim;
    setSessions((list) => {
      if (!list) return list;
      const next = list.filter((x) => x.sessionId !== s.sessionId);
      cacheSessions(host.id, listQuery.current.dir, next);
      return next;
    });
  };
  /** 新标签打开历史会话时的首次载入：并进唤醒屏（先读历史、再唤醒），不再叠一层载入遮罩 */
  const firstLoad = loadingSession && loadingSession === props.initialSession ? loadingSession : null;
  /** 正在播放删除动画的会话 */
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());

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
  /** 要滚到的消息（搜索当前命中、缩略导航点击） */
  const [reveal, setReveal] = useState<string | null>(null);
  useEffect(() => setReveal(currentMatch), [currentMatch]);
  useEffect(() => {
    if (!reveal) return;
    // 在还没渲染的更早部分：先展开到那里，渲染后本效果会再跑一次
    const idx = state.items.findIndex((it) => it.key === reveal);
    if (idx >= 0 && idx < shownFrom) {
      setShownFrom(Math.max(0, idx - 10));
      return;
    }
    scrollRef.current?.querySelector(`[data-key="${reveal}"]`)?.scrollIntoView({ block: "center" });
    setReveal(null);
  }, [reveal, shownFrom]);

  const stepMatch = (back: boolean) => {
    if (!search || !matches.length) return;
    const n = matches.length;
    setSearch({ ...search, index: (search.index + (back ? n - 1 : 1)) % n });
  };

  // 关键词高亮：用 CSS Custom Highlight 给命中的文字上色，不改 DOM（Markdown 是 innerHTML，插标签会被重渲染冲掉）
  const hlId = useRef(`p${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    const q = search?.q.trim().toLowerCase();
    const root = scrollRef.current;
    const hits: Range[] = [];
    const cur: Range[] = [];
    if (q && root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue!.toLowerCase();
        let i = text.indexOf(q);
        if (i < 0) continue;
        const inCur = !!currentMatch && n.parentElement?.closest<HTMLElement>("[data-key]")?.dataset.key === currentMatch;
        for (; i >= 0; i = text.indexOf(q, i + q.length)) {
          const r = new Range();
          r.setStart(n, i);
          r.setEnd(n, i + q.length);
          (inCur ? cur : hits).push(r);
        }
      }
    }
    setHighlights(hlId, hits, cur);
  }, [search?.q, currentMatch, state.items, shownFrom]);
  useEffect(() => () => setHighlights(hlId, [], []), []);

  /** 把文字以 Markdown 引用插到输入框末尾 */
  const quote = (text: string) => {
    const q = text.split("\n").map((l) => `> ${l}`).join("\n");
    setInput((cur) => `${cur.trimEnd() ? `${cur.trimEnd()}\n\n` : ""}${q}\n\n`);
    inputRef.current?.focus();
  };

  /** 消息上的右键菜单：选中文字 > 链接 > 代码块 > 整条消息 */
  const msgMenu = (e: React.MouseEvent<HTMLElement>, item: Item) => {
    const t = e.target as HTMLElement;
    const sel = selectedText(e.currentTarget);
    if (sel) {
      const short = sel.replace(/\s+/g, " ").slice(0, 16);
      return openMenu(e, [
        { label: "复制", hint: kbd("Ctrl+C"), onClick: () => copyText(sel) },
        { label: "引用到输入框", onClick: () => quote(sel) },
        { label: `在对话中搜索「${short}${sel.length > 16 ? "…" : ""}」`, hint: kbd("Ctrl+F"), onClick: () => setSearch({ q: sel, index: 0 }) },
      ]);
    }
    const href = t.closest("a")?.getAttribute("href");
    if (href && /^https?:\/\//.test(href)) {
      return openMenu(e, [
        { label: "在浏览器打开", onClick: () => openUrl(href) },
        { label: "复制链接", onClick: () => copyText(href) },
      ]);
    }
    const pre = t.closest("pre");
    if (pre) return openMenu(e, [{ label: "复制代码", onClick: () => copyText(pre.innerText) }]);
    const text = itemText(item);
    openMenu(e, [
      { label: "复制这条消息", onClick: () => copyText(text) },
      { label: "引用回复", onClick: () => quote(text) },
      ...(item.kind === "user"
        ? [
            {
              label: "重新编辑",
              onClick: () => {
                setInput(text);
                inputRef.current?.focus();
              },
            },
          ]
        : []),
    ]);
  };

  /** 上一个 / 下一个提问：以当前滚动位置为准；往上找不到已渲染的就去更早未渲染的部分 */
  const jumpAsk = (up: boolean) => {
    const el = scrollRef.current!;
    const top = (key: string) => el.querySelector<HTMLElement>(`[data-key="${key}"]`)?.offsetTop;
    const asks = state.items.flatMap((it, i) => (it.kind === "user" ? [{ key: it.key, i }] : []));
    const y = el.scrollTop;
    const pick = up
      ? [...asks].reverse().find((a) => {
          const t = top(a.key);
          return t === undefined ? a.i < shownFrom : t < y - 16;
        })
      : asks.find((a) => (top(a.key) ?? -1) > y + 16);
    if (!pick) return;
    const node = el.querySelector<HTMLElement>(`[data-key="${pick.key}"]`);
    if (node) node.scrollIntoView({ block: "start" });
    else setReveal(pick.key);
  };

  // 对话窗格里的快捷键（尽量和 IDEA 一致）；全局的在 App 里
  const onPaneKeyDown = (e: React.KeyboardEvent) => {
    const mod = modKey(e);
    const k = e.key.toLowerCase();
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    const plain = mod && !e.shiftKey && !e.altKey;
    let run: (() => void) | null = null;
    if (plain && k === "f") run = () => setSearch((s) => s ?? { q: "", index: 0 });
    else if (e.key === "F3" && search) run = () => stepMatch(e.shiftKey);
    else if (plain && k === "e")
      run = () => {
        setPicker({ q: "", index: 0 });
        if (sessions === null) loadSessions();
      };
    else if (e.altKey && !mod && e.key === "1") run = () => setShowSessions(!showSessions);
    else if (mod && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) run = () => jumpAsk(e.key === "ArrowUp");
    else if (plain && !typing && e.key === "End") run = toBottom;
    else if (plain && !typing && e.key === "Home" && state.items.length) run = () => setReveal(state.items[0].key);
    else if (mod && e.altKey && k === "n") run = () => switchTo(emptyState, listDir.trim() || "~");
    if (!run) return;
    e.preventDefault();
    run();
  };

  // ---- 输入框：/ 命令与 @ 文件补全 ----

  const updateCompletion = async (value: string, caret: number) => {
    const before = value.slice(0, caret);
    if (/^\/\S*$/.test(before)) {
      const q = before.slice(1).toLowerCase();
      // 本地命令优先，云端同名命令不重复列出
      const all = [...LOCAL_COMMANDS, ...state.slashCommands.filter((c) => !LOCAL_COMMANDS.some((l) => l.name === c.name))];
      const cmds = all.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 14);
      return setCompletion(
        cmds.length
          ? { items: cmds.map((c) => c.name), hints: cmds.map((c) => c.description), index: 0, start: 0, prefix: "/" }
          : null,
      );
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
    // Shift+Tab 轮换权限模式（和 Claude Code 命令行一样）
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      changeMode(nextMode(mode));
      return;
    }
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

  /** 目录下拉的建议：主机默认目录 + 云端 Claude 最近用过的目录 */
  const dirOptions = useMemo(
    () => [...new Set([host.dir, ...(recentDirs ?? [])].filter((d): d is string => !!d))].map((d) => ({ value: d })),
    [host.dir, recentDirs],
  );

  /** /resume 选择框里的候选：按标题（含本机重命名）和目录过滤，列表本身已按时间倒序 */
  const pickerItems = useMemo(() => {
    if (!picker) return [];
    const q = picker.q.trim().toLowerCase();
    return (sessions ?? [])
      .filter((s) => !q || `${titles[s.sessionId] ?? s.title} ${s.cwd}`.toLowerCase().includes(q))
      .slice(0, 50);
  }, [picker?.q, sessions, titles]);

  const pickSession = (s: ChatSession) => {
    setPicker(null);
    openSession(s, false);
    inputRef.current?.focus();
  };

  return (
    <div className={`chat-pane terminal-pane ${focused ? "focused" : ""}`} onMouseDown={props.onFocus} onKeyDown={onPaneKeyDown}>
      {booting &&
        (firstLoad ? (
          <ConnectScreen
            host={host}
            robot
            label={`正在载入「${(titles[firstLoad.sessionId] ?? firstLoad.title).slice(0, 40)}」`}
            detail={<code>{firstLoad.cwd}</code>}
            progress="读取历史会话"
          />
        ) : (
          <ConnectScreen host={host} robot label="正在唤醒 Claude" detail={<code>{cwd}</code>} progress="启动云端 Claude Code" />
        ))}
      {showMcp && (
        <McpPanel
          servers={state.mcpServers}
          tools={state.tools}
          loading={!state.sessionId && state.mcpServers.length === 0}
          pending={mcpPending}
          onReconnect={(n) => mcpAction(n)}
          onToggle={(n, enabled) => mcpAction(n, enabled)}
          onClose={() => setShowMcp(false)}
        />
      )}
      {picker && (
        <div className="pane-overlay" onMouseDown={(e) => e.target === e.currentTarget && setPicker(null)}>
          <div className="dialog session-picker">
            <h3>继续哪个会话</h3>
            <input
              autoFocus
              value={picker.q}
              placeholder="按标题或目录过滤（↑↓ 选择，Enter 继续，Esc 关闭）"
              onChange={(e) => setPicker({ q: e.target.value, index: 0 })}
              onKeyDown={(e) => {
                const n = pickerItems.length;
                if (e.key === "Escape") setPicker(null);
                else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setPicker({ ...picker, index: (picker.index + delta + n) % n });
                } else if (e.key === "Enter" && n) {
                  pickSession(pickerItems[picker.index % n]);
                }
              }}
            />
            <div className="picker-list">
              {sessions === null && <Loading text="正在读取历史会话" />}
              {sessions !== null && pickerItems.length === 0 && <p className="muted">没有匹配的会话</p>}
              {pickerItems.map((s, i) => (
                <div
                  key={s.sessionId}
                  className={`menu-item ${i === picker.index % pickerItems.length ? "selected" : ""}`}
                  onMouseEnter={() => setPicker({ ...picker, index: i })}
                  onClick={() => pickSession(s)}
                >
                  <span className="picker-title">{titles[s.sessionId] ?? s.title}</span>
                  <span className="muted menu-hint">
                    {basename(s.cwd)} · {hostDateTime(s.mtime, tz)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {showSessions && (
        <aside className="chat-sessions">
          <div className="chat-sessions-head">
            <span>历史会话</span>
            <button className="icon" title="收起会话列表，给对话让出空间（工具栏的 ☰ 可再展开）" onClick={() => setShowSessions(false)}>
              «
            </button>
          </div>
          <div className="chat-new">
            <Combo
              value={listDir}
              onChange={(v) => {
                setListDir(v);
                // 从建议里选中就立即切换；手动输入的等失焦再读
                if (dirOptions.some((o) => o.value === v)) showDir(v);
              }}
              onBlur={showDir}
              options={dirOptions}
              loading={recentDirs === null ? "正在读取最近用过的目录" : undefined}
              placeholder="工作目录，如 ~/project"
              title="只显示这个目录的历史会话，「新对话」也在这个目录开始"
            />
            <button className="primary" onClick={() => switchTo(emptyState, listDir.trim() || "~")}>
              新对话
            </button>
          </div>
          <input value={sessionFilter} onChange={(e) => setSessionFilter(e.target.value)} placeholder="搜索会话" />
          <div className="chat-session-list">
            {sessions === null && <Loading text={allDirs ? "正在读取全部历史会话" : "正在读取这个目录的会话"} />}
            {sessions?.length === 0 && <p className="muted">{allDirs ? "还没有历史会话" : "这个目录下还没有历史会话"}</p>}
            {grouped.map(([c, list]) => (
              <div key={c}>
                {allDirs && (
                  <div className="group-head" title={c}>
                    {basename(c)}
                  </div>
                )}
                {list.map((s) => (
                  <div
                    key={s.sessionId}
                    className={`chat-session ${(loadingSession ? s.sessionId === loadingSession.sessionId : s.sessionId === state.sessionId) ? "active" : ""} ${
                      s.sessionId === loadingSession?.sessionId ? "loading" : ""
                    } ${removing.has(s.sessionId) ? "removing" : ""}`}
                    onClick={(e) => openSession(s, e.ctrlKey || e.metaKey)}
                    // 中键：新标签打开（按下时拦掉浏览器的自动滚动）
                    onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                    onAuxClick={(e) => e.button === 1 && openSession(s, true)}
                    onContextMenu={(e) =>
                      openMenu(e, [
                        { label: "打开", onClick: () => openSession(s, false) },
                        { label: "在新标签打开", hint: kbd("Ctrl+点击"), onClick: () => openSession(s, true) },
                        "sep",
                        { label: "重命名", onClick: () => setRenaming({ id: s.sessionId, value: titles[s.sessionId] ?? s.title }) },
                        { label: "删除", danger: true, onClick: () => deleteSession(s) },
                      ])
                    }
                    title={`${titles[s.sessionId] ?? s.title}\n${kbd("中键或 Ctrl+点击")}：在新标签打开`}
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
                      <div className="chat-session-title">
                        {titles[s.sessionId] ?? s.title}
                        {s.sessionId === loadingSession?.sessionId && <span className="spinner" aria-label="正在载入" />}
                      </div>
                    )}
                    <div className="row chat-session-meta">
                      <span className="muted small-text grow" title={tzLabel(tz)}>
                        {hostDateTime(s.mtime, tz)}
                      </span>
                      <span className="chat-session-actions">
                        <button
                          className="icon"
                          title="在新标签打开"
                          onClick={(e) => {
                            e.stopPropagation();
                            openSession(s, true);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                          </svg>
                        </button>
                        <button
                          className="icon"
                          title="重命名"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenaming({ id: s.sessionId, value: titles[s.sessionId] ?? s.title });
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
                          </svg>
                        </button>
                        <button
                          className="icon del"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(s);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
                          </svg>
                        </button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="row chat-sessions-foot">
            <button className="link" onClick={() => loadSessions()}>
              刷新
            </button>
            <div className="grow" />
            {allDirs ? (
              <button className="link" onClick={() => showDir(listDir)}>
                只看当前目录
              </button>
            ) : (
              <button
                className="link"
                title="扫一遍所有目录最近的会话，会慢一些"
                onClick={() => {
                  setAllDirs(true);
                  loadSessions(null);
                }}
              >
                查看全部目录
              </button>
            )}
          </div>
        </aside>
      )}

      <div className="chat-main">
        {loadingSession && !firstLoad && (
          <div className="session-loading">
            <div className="session-loading-card">
              <Loading text={`正在载入「${(titles[loadingSession.sessionId] ?? loadingSession.title).slice(0, 40)}」`} />
            </div>
          </div>
        )}
        <div className="chat-toolbar">
          <button
            className={`icon sessions-toggle ${showSessions ? "" : "off"}`}
            title={kbd(showSessions ? "收起会话列表（Alt+1）" : "展开会话列表（Alt+1），Ctrl+E 快速打开最近会话")}
            aria-pressed={showSessions}
            onClick={() => setShowSessions(!showSessions)}
          >
            ☰
          </button>
          <span className="chat-cwd" title={cwd}>
            {cwd}
          </span>
          <Combo
            className="chat-model"
            value={model}
            placeholder={state.model ?? "默认模型"}
            onChange={setModel}
            onBlur={(v) => changeModel(v.trim())}
            title="模型（留空为默认）"
            options={(state.models.length ? state.models : MODELS.filter(Boolean).map((m) => ({ value: m, label: m }))).map((m) => ({
              value: m.value,
              hint: m.label && m.label !== m.value ? String(m.label) : undefined,
            }))}
          />
          {state.mcpServers.length > 0 && (
            <button
              className={`mcp-badge ${state.mcpServers.some((m) => m.status !== "connected" && m.status !== "disabled") ? "warn" : ""}`}
              title="查看 MCP 服务器（/mcp）"
              onClick={openMcp}
            >
              MCP {state.mcpServers.filter((m) => m.status === "connected").length}/{state.mcpServers.length}
            </button>
          )}
          <div className="menu-anchor">
            <button ref={commandsBtn} className="icon" title="常用命令" onClick={() => setShowCommands(!showCommands)}>
              ⌘
            </button>
            {showCommands && (
              // 挂到 body 上并按窗口边界定位：原来右对齐向左长，说明一长就把左半边顶出窗格被裁掉
              <PopupMenu anchor={commandsBtn} onClose={() => setShowCommands(false)} className="commands-menu">
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
                  .filter((c) => c.name !== "compact" && c.name !== "clear")
                  .map((c) => (
                    <div
                      key={c.name}
                      className="menu-item"
                      title={c.description}
                      onClick={() => {
                        setShowCommands(false);
                        setInput(`/${c.name} `);
                        inputRef.current?.focus();
                      }}
                    >
                      <code>/{c.name}</code>
                      {c.description && <span className="muted menu-hint">{c.description}</span>}
                    </div>
                  ))}
                {!state.slashCommands.length && <div className="menu-item muted">正在从云端 claude 读取可用命令…</div>}
              </PopupMenu>
            )}
          </div>
          <button className="icon" title={kbd("搜索对话（Ctrl+F，F3 / Shift+F3 下一个 / 上一个）")} onClick={() => setSearch((s) => s ?? { q: "", index: 0 })}>
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
                if (e.key === "Enter") stepMatch(e.shiftKey);
              }}
            />
            <span className="search-count muted small-text">
              {matches.length ? `${(search.index % matches.length) + 1} / ${matches.length}` : search.q ? "无结果" : ""}
            </span>
            <button className="icon" title="上一个（Shift+Enter）" disabled={!matches.length} onClick={() => stepMatch(true)}>
              ↑
            </button>
            <button className="icon" title="下一个（Enter）" disabled={!matches.length} onClick={() => stepMatch(false)}>
              ↓
            </button>
            <button className="icon" onClick={() => setSearch(null)}>
              ×
            </button>
          </div>
        )}

        <div
          className={"chat-stage" + (resizing ? " resizing" : "")}
          style={{ "--chat-width": chatWidth ? `${chatWidth}px` : "100%" } as React.CSSProperties}
        >
        <div className="chat-resize left" title="拖动调整对话宽度 · 双击恢复默认" onPointerDown={startResize} onDoubleClick={resetWidth} />
        <div className="chat-resize right" title="拖动调整对话宽度 · 双击恢复默认" onPointerDown={startResize} onDoubleClick={resetWidth} />
        <div
          className="chat-messages"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (nearBottom.current) setBehind(false);
            if (el.scrollTop < 40) loadEarlier();
          }}
        >
          {shownFrom > 0 && (
            <button className="load-earlier" onClick={loadEarlier}>
              ↑ 加载更早的消息（还有 {shownFrom} 条）
            </button>
          )}
          {state.items.length === 0 && !state.running && (
            <div className="placeholder chat-empty">
              <Logo size={56} className="logo-idle" />
              在 {host.name} 的 <code>{cwd}</code> 中和 Claude Code 对话
              <div className="muted small-text">Enter 发送 · Shift+Enter 换行 · / 命令 · @ 引用文件 · 可粘贴截图 · Esc 中断</div>
            </div>
          )}
          {state.items.slice(shownFrom).map((item, i) => {
            const idx = shownFrom + i;
            const hit = matches.includes(item.key) ? (item.key === currentMatch ? " search-current" : " search-hit") : "";
            // 连续的多条回复（文字、工具调用…）只在第一条上显示角色标
            const showRole = item.kind !== "system" && state.items[idx - 1]?.kind !== item.kind;
            if (item.kind === "system") {
              return (
                <div key={item.key} data-key={item.key} className={`chat-system ${item.tone}${hit}`}>
                  {item.text}
                </div>
              );
            }
            return (
              <div
                key={item.key}
                data-key={item.key}
                className={`chat-msg ${item.kind}${showRole ? " first" : ""}${hit}`}
                onContextMenu={(e) => msgMenu(e, item)}
              >
                {showRole && (item.kind === "assistant" ? <ClaudeRole /> : <UserRole at={item.at} tz={tz} />)}
                <div className="msg-actions">
                  <button className="icon" title="复制这条消息" onClick={() => copyText(itemText(item))}>
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
                {item.kind === "assistant" && item.done && (
                  <div className="turn-done" title={hostDateTime(item.done.at / 1000, tz)}>
                    ✻ {hostShortTime(item.done.at / 1000, tz, true)} · 耗时 {duration(item.done.ms)}
                  </div>
                )}
              </div>
            );
          })}
          {state.streaming && (
            <div className={`chat-msg assistant streaming${state.items[state.items.length - 1]?.kind !== "assistant" ? " first" : ""}`}>
              {state.items[state.items.length - 1]?.kind !== "assistant" && <ClaudeRole />}
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
              {lastUserAt(state.items) && <Elapsed since={lastUserAt(state.items)!} />}
              <button className="link" onClick={() => write(controlRequest({ subtype: "interrupt" }))}>
                中断（Esc）
              </button>
            </div>
          )}
        </div>
        <ChatMinimap scrollRef={scrollRef} items={state.items} shownFrom={shownFrom} matches={matches} onJump={setReveal} />
        {behind && (
          <div className="jump-latest-wrap">
            <button className="jump-latest" onClick={toBottom}>
              <span className="jump-arrow" aria-hidden="true">
                ↓
              </span>
              有新内容，跳到最新
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
                  <span>
                    {completion.prefix}
                    {c}
                  </span>
                  {completion.hints?.[i] && <span className="muted menu-hint">{completion.hints[i]}</span>}
                </div>
              ))}
            </div>
          )}
          {coldTokens() !== null && (
            <div className={`cold-notice${coldArmed ? " armed" : ""}${coldTokens()! >= COLD_HEAVY_TOKENS ? " heavy" : ""}`}>
              <div className="cold-text">
                {coldTokens()! >= COLD_HEAVY_TOKENS && <div className="cold-head">⚠ 大会话冷启动：下一条消息会把整段上下文重新写入缓存</div>}
                此会话上下文约 <b>{Math.round(coldTokens()! / 1000)}k</b> tokens，已闲置 {idleText(Date.now() - state.lastActive!)}，缓存已过期
                {coldPct(coldTokens()!) !== null && (
                  <>
                    （预计约消耗 5 小时额度的 <b>{pctText(coldPct(coldTokens()!)!)}</b>）
                  </>
                )}
                。发送消息或执行 /compact 都会按完整上下文重新计费一次。只是追问一两句就直接发；还要继续很多轮，先 /compact
                更省；不需要旧上下文的话，新开会话不消耗额度。
                {coldArmed && <div className="cold-armed">⚠ 消息还没发出。再按一次发送（Enter）就按冷启动计费发出去。</div>}
              </div>
              <div className="cold-actions">
                <button onClick={() => sendText("/compact")}>/compact</button>
                <button onClick={() => switchTo(emptyState, cwd)}>新开会话</button>
                <button
                  className="link"
                  onClick={() => {
                    setColdAck(state.lastActive);
                    setColdArmed(false);
                  }}
                >
                  知道了
                </button>
              </div>
            </div>
          )}
          <ChatStatus
            mode={mode}
            onMode={changeMode}
            usage={state.usage}
            rateLimits={state.rateLimits}
            tz={tz}
            baseContext={baseContext}
            onHotCompact={
              !state.running &&
              (state.usage.contextUsed ?? 0) > HOT_COMPACT_TOKENS &&
              state.lastActive &&
              Date.now() - state.lastActive < CACHE_TTL_MS
                ? () => sendText("/compact")
                : undefined
            }
          />
          <textarea
            ref={inputRef}
            value={input}
            rows={2}
            placeholder={
              state.running ? "Claude 正在工作，可以继续输入（会排队）" : "给 Claude 发消息（Enter 发送，Shift+Enter 换行，/ 命令，@ 文件）"
            }
            onChange={(e) => {
              setInput(e.target.value);
              updateCompletion(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="chat-input-actions">
            <button title="从本机选择文件，上传到云主机后把路径插入输入框" disabled={uploading} onClick={attachFiles}>
              {uploading ? "上传中…" : "⊕ 附件"}
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
