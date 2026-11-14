import { useEffect, useMemo, useRef, useState } from "react";
import { Loading } from "./Loading";
import { ConnectScreen } from "./ConnectScreen";
import { hostDateTime, tzLabel, useHostTz } from "./hostTime";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
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
  itemText,
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
import { ChatStatus, nextMode } from "./ChatStatus";
import { PermissionCard, ToolCard } from "./ToolCard";
const MODELS = ["", "opus", "sonnet", "haiku"];

/** 记在本机的用量快照（按主机）：额度只在回复后才报告，先显示上次的 */
interface SavedUsage {
  rateLimits: ChatState["rateLimits"];
  contextWindow: number | null;
}
const usageKey = (hostId: string) => `ccws.usage.${hostId}`;
function loadUsage(hostId: string): SavedUsage {
  try {
    const v = JSON.parse(localStorage.getItem(usageKey(hostId)) ?? "null");
    if (v && typeof v === "object") return { rateLimits: v.rateLimits ?? {}, contextWindow: v.contextWindow ?? null };
  } catch {
    // 读不到就当没有
  }
  return { rateLimits: {}, contextWindow: null };
}
function saveUsage(hostId: string, u: SavedUsage) {
  try {
    localStorage.setItem(usageKey(hostId), JSON.stringify(u));
  } catch {
    // 存不下只是下次打开先显示空
  }
}
function withSavedUsage(s: ChatState, u: SavedUsage): ChatState {
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
  const [showSessions, setShowSessions] = useState(true);
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
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 打开即预热：后台启动云端 claude 并拿命令列表；关标签时结束它
  useEffect(() => {
    loadSessions(listQuery.current.dir);
    api
      .chatDirs(host.id)
      .then(setRecentDirs)
      .catch(() => setRecentDirs([]));
    warm();
    return () => {
      if (chatIdRef.current) api.chatStop(chatIdRef.current);
    };
  }, []);

  // 额度和上下文窗口一有更新就记下来（按主机）
  useEffect(() => {
    saveUsage(host.id, { rateLimits: state.rateLimits, contextWindow: state.usage.contextWindow });
  }, [state.rateLimits, state.usage.contextWindow]);

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
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.streaming, state.permissions]);

  useEffect(() => {
    if (visible && focused) inputRef.current?.focus();
  }, [visible, focused]);

  /** 读历史会话：dir 为 null 时读全部目录；不传则按上次的条件重读 */
  const loadSessions = (dir: string | null = listQuery.current.dir) => {
    const seq = listQuery.current.seq + 1;
    listQuery.current = { dir, seq };
    setSessions(null);
    api
      .chatSessions(host.id, dir)
      .then((list) => listQuery.current.seq === seq && setSessions(list))
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
      if (latest) resume(latest);
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
    // 额度是账号级的、窗口大小跟模型走，换会话都不清空
    setState((s) => withSavedUsage(next, { rateLimits: s.rateLimits, contextWindow: s.usage.contextWindow }));
    setCwd(nextCwd);
    propsRef.current.onTitle(basename(nextCwd));
    warm();
  };

  /** 正在载入的历史会话（显示载入动画）；序号用来丢掉被后一次点击取代的结果 */
  const [loadingSession, setLoadingSession] = useState<ChatSession | null>(null);
  const resumeSeq = useRef(0);

  const resume = async (s: ChatSession) => {
    const seq = ++resumeSeq.current;
    setLoadingSession(s);
    try {
      const lines = await api.chatHistory(host.id, s.file);
      if (seq !== resumeSeq.current) return;
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
      switchTo({ ...fromHistory(lines), sessionId: s.sessionId }, s.cwd);
      propsRef.current.onTitle(s.title.slice(0, 30));
    } catch (e) {
      if (seq === resumeSeq.current) setState((st) => system(st, `读取会话失败：${errorText(e)}`, "error"));
    } finally {
      if (seq === resumeSeq.current) setLoadingSession(null);
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
    resume(s);
    inputRef.current?.focus();
  };

  return (
    <div className={`chat-pane terminal-pane ${focused ? "focused" : ""}`} onMouseDown={props.onFocus} onKeyDown={onPaneKeyDown}>
      {booting && <ConnectScreen host={host} robot label="正在唤醒 Claude" detail={<code>{cwd}</code>} progress="启动云端 Claude Code" />}
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
                    }`}
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
        {loadingSession && (
          <div className="session-loading">
            <div className="session-loading-card">
              <Loading text={`正在载入「${(titles[loadingSession.sessionId] ?? loadingSession.title).slice(0, 40)}」`} />
            </div>
          </div>
        )}
        <div className="chat-toolbar">
          <button className="icon" title="显示/隐藏会话列表" onClick={() => setShowSessions(!showSessions)}>
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
                  <span>
                    {completion.prefix}
                    {c}
                  </span>
                  {completion.hints?.[i] && <span className="muted menu-hint">{completion.hints[i]}</span>}
                </div>
              ))}
            </div>
          )}
          <ChatStatus mode={mode} onMode={changeMode} usage={state.usage} rateLimits={state.rateLimits} tz={tz} />
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
