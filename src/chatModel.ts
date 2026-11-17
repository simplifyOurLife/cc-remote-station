/** Claude Code stream-json 协议的前端模型：把事件归并成可渲染的消息列表 */

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, any> }
  | { type: "image"; src: string };

export type Item =
  /** at：发送时间（毫秒） */
  | { kind: "user"; key: string; blocks: Block[]; at?: number }
  /** done：这条是一轮的最后一条回复时，这轮的结束时间和耗时（毫秒） */
  | { kind: "assistant"; key: string; messageId: string; blocks: Block[]; done?: { at: number; ms: number } }
  | { kind: "system"; key: string; text: string; tone: "info" | "error" };

export interface ToolResult {
  text: string;
  isError: boolean;
}

/** 子代理（Task 工具）里的一步：只记摘要，展示在对应 Task 卡片里 */
export interface SubStep {
  kind: "tool" | "text";
  text: string;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, any>;
  /** 为什么问我：decision_reason 缺失时回退到 description */
  reason: string;
  /** CLI 给出的「记住这条规则」建议，选「本次会话都允许」时原样回传 */
  suggestions: unknown[] | null;
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** init 只给命令名：补进列表，但不覆盖 initialize 已经拿到的说明 */
function mergeCommands(cur: SlashCommand[], names: string[]): SlashCommand[] {
  const known = new Set(cur.map((c) => c.name));
  return [...cur, ...names.filter((n) => !known.has(n)).map((name) => ({ name }))];
}

/** 用量：各项拿不到时为 null（如还没回复过） */
export interface Usage {
  /** 本会话累计花费（来自每轮 result 的 total_cost_usd） */
  costUsd: number | null;
  /** 当前上下文大小：最近一次回复的 输入 + 缓存写入 + 缓存命中 + 输出 */
  contextUsed: number | null;
  /** 模型的上下文窗口（来自 result.modelUsage） */
  contextWindow: number | null;
}

/** 订阅额度（速率限制）的一个窗口：CLI 以 rate_limit_event 上报，字段按宽松方式解析 */
export interface RateLimit {
  /** allowed / allowed_warning / rejected */
  status: string;
  /** 重置时间，Unix 秒 */
  resetsAt: number | null;
  /** five_hour / seven_day / seven_day_opus … */
  window: string;
  /** 已用百分比（0–100），没报告就是 null */
  usedPct: number | null;
  /** 收到这条数据的时间（毫秒），用于提示数据新旧 */
  updatedAt: number;
}

export interface ChatState {
  items: Item[];
  /** 正在流式输出、尚未收到完整 assistant 消息的文字 */
  streaming: string;
  results: Record<string, ToolResult>;
  /** Task 工具 id → 子代理的执行步骤 */
  subs: Record<string, SubStep[]>;
  permissions: PermissionRequest[];
  /** 一轮对话是否在进行（进程在轮与轮之间不退出，不能拿进程存活当忙碌） */
  running: boolean;
  sessionId: string | null;
  model: string | null;
  /** 可用斜杠命令：initialize 回执带说明，init 事件只有名字 */
  slashCommands: SlashCommand[];
  /** initialize 回执里的可选模型 */
  models: { value: string; label: string }[];
  /** 云端 claude 加载的 MCP 服务器及状态（init 事件只有名字和状态，mcp_status 回执更详细） */
  mcpServers: McpServer[];
  /** 本轮可用的全部工具名（来自 init），MCP 工具形如 mcp__服务器__工具 */
  tools: string[];
  usage: Usage;
  /** 各额度窗口的最新状态，按窗口名 */
  rateLimits: Record<string, RateLimit>;
  /** 会话最后一次活动的时间（毫秒）：超过缓存有效期后，下一轮要按完整上下文重新计费 */
  lastActive: number | null;
  /** 最近的 stderr，进程异常退出时展示 */
  stderr: string[];
}

export const emptyState: ChatState = {
  items: [],
  streaming: "",
  results: {},
  subs: {},
  permissions: [],
  running: false,
  sessionId: null,
  model: null,
  slashCommands: [],
  models: [],
  mcpServers: [],
  tools: [],
  usage: { costUsd: null, contextUsed: null, contextWindow: null },
  rateLimits: {},
  lastActive: null,
  stderr: [],
};

let seq = 0;
const key = () => `k${++seq}`;

/** 工具调用的一行摘要：取最能说明在做什么的参数 */
export function toolSummary(name: string, input: Record<string, any>): string {
  return (
    input.command ??
    input.file_path ??
    input.notebook_path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.description ??
    input.prompt ??
    (name === "TodoWrite" ? `${input.todos?.length ?? 0} 项待办` : "")
  );
}

/** tool_result 的 content 可能是字符串，也可能是 text/image 块数组 */
function resultText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[图片]" : "")).join("\n");
}

function toBlocks(content: any): Block[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  const blocks: Block[] = [];
  for (const b of content ?? []) {
    if (b.type === "text" && b.text?.trim()) blocks.push({ type: "text", text: b.text });
    else if (b.type === "thinking" && b.thinking) blocks.push({ type: "thinking", text: b.thinking });
    else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
    else if (b.type === "image" && b.source?.data)
      blocks.push({ type: "image", src: `data:${b.source.media_type};base64,${b.source.data}` });
  }
  return blocks;
}

/** 同一条 assistant 消息会按内容块分多次到达，按 message.id 合并 */
function addAssistant(items: Item[], messageId: string, blocks: Block[]): Item[] {
  const last = items[items.length - 1];
  if (last?.kind === "assistant" && last.messageId === messageId) {
    return [...items.slice(0, -1), { ...last, blocks: [...last.blocks, ...blocks] }];
  }
  return [...items, { kind: "assistant", key: key(), messageId, blocks }];
}

/** 用户消息里可能混着 tool_result（工具回传）和真正的用户输入 */
function addUser(s: ChatState, content: any, at?: number, compactSummary?: boolean): ChatState {
  // CLI 塞进对话的本地记录：压缩摘要不显示（压缩点另有提示），本地命令的回显丢掉、输出转成系统提示
  const text = typeof content === "string" ? content : content?.length === 1 && content[0].type === "text" ? String(content[0].text) : null;
  if (compactSummary || text?.startsWith("This session is being continued from a previous conversation")) return s;
  if (text !== null) {
    const t = text.trim();
    const out = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/.exec(t);
    if (out) {
      const msg = out[2].trim();
      return !msg || msg === "Compacted" || msg === "(no content)" ? s : system(s, msg, out[1] === "stderr" ? "error" : "info");
    }
    if (/^<(command-name|command-message|local-command-caveat)>/.test(t)) return s;
  }
  const results = { ...s.results };
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "tool_result") results[b.tool_use_id] = { text: resultText(b.content), isError: !!b.is_error };
    }
  }
  const blocks = toBlocks(Array.isArray(content) ? content.filter((b: any) => b.type !== "tool_result") : content);
  const items = blocks.length ? [...s.items, { kind: "user" as const, key: key(), blocks, at }] : s.items;
  return { ...s, results, items };
}

/** 给本轮（最后一条用户消息之后）的最后一条回复打上结束时间和耗时；本轮没有回复就不动 */
function markTurnEnd(items: Item[], at: number, ms: number): Item[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return items;
    if (it.kind === "assistant") return [...items.slice(0, i), { ...it, done: { at, ms } }, ...items.slice(i + 1)];
  }
  return items;
}

/** 最后一条用户消息的发送时间（本轮开始时间） */
export function lastUserAt(items: Item[]): number | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return it.at;
  }
}

/** 子代理的消息带 parent_tool_use_id：不进主对话，记为对应 Task 卡片里的步骤 */
function addSub(s: ChatState, parent: string, content: any): ChatState {
  const steps: SubStep[] = [];
  const results = { ...s.results };
  for (const b of Array.isArray(content) ? content : []) {
    if (b.type === "tool_use") steps.push({ kind: "tool", text: `${b.name}  ${toolSummary(b.name, b.input ?? {})}` });
    else if (b.type === "text" && b.text?.trim()) steps.push({ kind: "text", text: b.text.trim() });
    else if (b.type === "tool_result") results[b.tool_use_id] = { text: resultText(b.content), isError: !!b.is_error };
  }
  if (!steps.length) return { ...s, results };
  return { ...s, results, subs: { ...s.subs, [parent]: [...(s.subs[parent] ?? []), ...steps] } };
}

/** 本地发出的用户消息立即上屏（CLI 不回显用户输入），并进入进行中状态 */
export function addLocalUser(s: ChatState, text: string, images: string[]): ChatState {
  const blocks: Block[] = images.map((src) => ({ type: "image", src }));
  if (text.trim()) blocks.push({ type: "text", text });
  return { ...s, running: true, items: [...s.items, { kind: "user", key: key(), blocks, at: Date.now() }] };
}

function compactNote(preTokens: unknown): string {
  const k = typeof preTokens === "number" ? `（压缩前约 ${Math.round(preTokens / 1000)}k tokens）` : "";
  return `上下文已压缩${k}，更早的细节 Claude 可能记不清了`;
}

export function system(s: ChatState, text: string, tone: "info" | "error" = "info"): ChatState {
  return { ...s, items: [...s.items, { kind: "system", key: key(), text, tone }] };
}

/** 处理一条来自云端 claude 的事件 */
export function reduce(s: ChatState, e: Record<string, any>): ChatState {
  // 子代理的 assistant / user 消息归到对应 Task 卡片
  if ((e.type === "assistant" || e.type === "user") && e.parent_tool_use_id) {
    return addSub(s, e.parent_tool_use_id, e.message?.content);
  }
  switch (e.type) {
    case "system":
      if (e.subtype === "init") {
        return {
          ...s,
          sessionId: e.session_id ?? s.sessionId,
          model: e.model ?? s.model,
          slashCommands: mergeCommands(s.slashCommands, e.slash_commands ?? []),
          mcpServers: e.mcp_servers ? mergeServers(s.mcpServers, e.mcp_servers) : s.mcpServers,
          tools: e.tools ?? s.tools,
        };
      }
      if (e.subtype === "compact_boundary") return system(s, compactNote(e.compact_metadata?.pre_tokens));
      return s;
    case "stream_event": {
      // 子代理的流式片段不显示在主对话里
      if (e.parent_tool_use_id) return s;
      const ev = e.event ?? {};
      // 流式的 message_start / message_delta 带着本次回复的用量，上下文大小边回复边更新
      if (ev.type === "message_start") return withContext({ ...s, streaming: "" }, ev.message?.usage);
      if (ev.type === "message_delta") return withContext(s, ev.usage);
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        return { ...s, streaming: s.streaming + ev.delta.text };
      }
      return s;
    }
    case "assistant":
      return withContext(
        { ...s, streaming: "", items: addAssistant(s.items, e.message?.id ?? key(), toBlocks(e.message?.content)) },
        e.message?.usage,
      );
    case "user":
      return addUser(s, e.message?.content, undefined, e.isCompactSummary);
    case "rate_limit_event": {
      const list = rateLimitsOf(e.rate_limit_info ?? {});
      if (!list.length) return s;
      return { ...s, rateLimits: { ...s.rateLimits, ...Object.fromEntries(list.map((r) => [r.window, r])) } };
    }
    case "result": {
      const usage = { ...s.usage, costUsd: e.total_cost_usd ?? s.usage.costUsd, contextWindow: contextWindowOf(e) ?? s.usage.contextWindow };
      const now = Date.now();
      const start = lastUserAt(s.items);
      const ms = typeof e.duration_ms === "number" ? e.duration_ms : start ? now - start : null;
      const items = ms !== null ? markTurnEnd(s.items, now, ms) : s.items;
      const next = { ...s, items, running: false, streaming: "", usage, lastActive: now };
      return e.is_error ? system(next, `本轮出错：${e.result ?? e.subtype}`, "error") : next;
    }
    case "control_request":
      if (e.request?.subtype === "can_use_tool") {
        const r = e.request;
        const req: PermissionRequest = {
          requestId: e.request_id,
          toolName: r.tool_name,
          input: r.input ?? {},
          reason: r.decision_reason || r.description || "",
          suggestions: r.permission_suggestions ?? null,
        };
        return { ...s, permissions: [...s.permissions, req] };
      }
      return s;
    case "control_cancel_request":
      return { ...s, permissions: s.permissions.filter((p) => p.requestId !== e.request_id) };
    case "control_response": {
      if (e.response?.subtype === "error") {
        // 老版本 CLI 不认 initialize 时静默忽略，命令列表退回到第一轮 init 里取
        const id = String(e.response.request_id ?? "");
        // mcp_status 同理：不支持就只用 init 里的简要状态
        if (id.startsWith(INIT_PREFIX) || id.startsWith(MCP_STATUS_PREFIX)) return s;
        return system(s, `操作未生效：${e.response.error}`, "error");
      }
      // initialize 回执：还没发消息就能拿到完整命令列表（带说明）和可选模型
      const r = e.response?.response ?? {};
      const next = { ...s };
      if (Array.isArray(r.mcpServers)) next.mcpServers = r.mcpServers.map(parseServer);
      if (Array.isArray(r.commands)) {
        next.slashCommands = r.commands.map((c: any) =>
          typeof c === "string" ? { name: c } : { name: c.name, description: c.description, argumentHint: c.argumentHint },
        );
      }
      if (Array.isArray(r.models)) {
        next.models = r.models.map((m: any) =>
          typeof m === "string" ? { value: m, label: m } : { value: m.value, label: m.displayName ?? m.value },
        );
      }
      return next;
    }
    case "stderr":
      return { ...s, stderr: [...s.stderr, e.text].slice(-30) };
    case "stdout":
      return system(s, e.text);
    case "exit": {
      const next = { ...s, running: false, streaming: "", permissions: [] };
      if (e.code === 0 || e.code === null) return next;
      const detail = s.stderr.join("\n").trim() || "（无输出）";
      return system(next, `云端 claude 异常退出（退出码 ${e.code}）：\n${detail}`, "error");
    }
    default:
      return s;
  }
}

function oneLimit(window: string, w: Record<string, any>, now: number): RateLimit | null {
  if (!w?.status) return null;
  const resets = w.resetsAt ?? null;
  const used = w.utilization ?? null;
  return {
    status: String(w.status),
    resetsAt: typeof resets === "number" ? (resets > 1e12 ? Math.round(resets / 1000) : resets) : null,
    window,
    // utilization 是 0–1 的比例
    usedPct: typeof used === "number" ? Math.round(used <= 1 ? used * 100 : used) : null,
    updatedAt: now,
  };
}

/**
 * 额度事件（rate_limit_event.rate_limit_info）：unifiedWindows 里是各窗口（five_hour / seven_day…）的已用比例、
 * 重置时间和状态；外层只有当前最关键的那个窗口。没有 unifiedWindows 的旧版本就用外层
 */
function rateLimitsOf(info: Record<string, any>): RateLimit[] {
  const now = Date.now();
  const windows = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : null;
  if (windows) {
    return Object.entries(windows)
      .map(([name, w]) => oneLimit(name, w as Record<string, any>, now))
      .filter((r): r is RateLimit => !!r);
  }
  const one = oneLimit(String(info.rateLimitType ?? "default"), info, now);
  return one ? [one] : [];
}

/** 一次回复的上下文大小：输入 + 缓存写入 + 缓存命中 + 输出 */
function contextOf(u: Record<string, any> | undefined): number | null {
  if (!u || typeof u.input_tokens !== "number") return null;
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
}

function withContext(s: ChatState, u: Record<string, any> | undefined): ChatState {
  const used = contextOf(u);
  return used === null ? s : { ...s, usage: { ...s.usage, contextUsed: used } };
}

/** 主模型的上下文窗口：modelUsage 里 token 最多的那个（子代理可能用了小模型） */
function contextWindowOf(e: Record<string, any>): number | null {
  const models = Object.values(e.modelUsage ?? {}) as any[];
  if (!models.length) return null;
  const size = (m: any) => (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
  const main = models.reduce((a, b) => (size(b) > size(a) ? b : a));
  return typeof main.contextWindow === "number" ? main.contextWindow : null;
}

/** 把会话 jsonl 的历史行转成初始状态（用于继续历史会话时回显） */
export function fromHistory(lines: Record<string, any>[]): ChatState {
  let s = emptyState;
  // 历史里没有每轮耗时：用「用户发消息」到「这轮最后一条回复」的时间差
  let turnStart: number | null = null;
  let lastReply: number | null = null;
  const endTurn = (items: Item[]) => (turnStart && lastReply ? markTurnEnd(items, lastReply, lastReply - turnStart) : items);
  for (const l of lines) {
    const t = Date.parse(l.timestamp);
    if (t > (s.lastActive ?? 0)) s = { ...s, lastActive: t };
    if (l.isMeta || l.isSidechain) continue;
    if (l.type === "user") {
      const before = s.items;
      s = addUser(s, l.message?.content, t || undefined, l.isCompactSummary);
      // 新的一轮（不是只带工具结果、也不是本地命令输出的用户行）：结算上一轮
      if (s.items.length > before.length && s.items[s.items.length - 1].kind === "user") {
        s = { ...s, items: [...endTurn(before), s.items[s.items.length - 1]] };
        turnStart = t || null;
        lastReply = null;
      }
    } else if (l.type === "system" && l.subtype === "compact_boundary") {
      s = system(s, compactNote(l.preTokens));
    } else if (l.type === "assistant") {
      if (t) lastReply = t;
      // 历史里的 assistant 记录带着当时的用量，取最后一条就是继续会话时的上下文大小
      s = withContext({ ...s, items: addAssistant(s.items, l.message?.id ?? key(), toBlocks(l.message?.content)) }, l.message?.usage);
    }
  }
  return { ...s, items: endTurn(s.items) };
}

/** 一条消息里的纯文字（复制、搜索用） */
export function itemText(item: Item): string {
  if (item.kind === "system") return item.text;
  return item.blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_use" ? `${b.name} ${toolSummary(b.name, b.input)}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** 导出成 Markdown：用户/Claude 分节，工具调用压成一行，系统提示用引用 */
export function toMarkdown(s: ChatState, title: string): string {
  const parts = [`# ${title}`, ""];
  for (const item of s.items) {
    if (item.kind === "system") {
      parts.push(`> ${item.text.replace(/\n/g, "\n> ")}`, "");
      continue;
    }
    parts.push(item.kind === "user" ? "## 用户" : "## Claude", "");
    for (const b of item.blocks) {
      if (b.type === "text") parts.push(b.text, "");
      else if (b.type === "tool_use") {
        const r = s.results[b.id];
        parts.push(`- 🔧 **${b.name}** \`${toolSummary(b.name, b.input)}\`${r?.isError ? "（失败）" : ""}`, "");
      } else if (b.type === "image") parts.push("*[图片]*", "");
    }
  }
  return parts.join("\n");
}

// ---- 发往云端的消息 ----

export function userMessage(text: string, images: string[], sessionId: string | null) {
  const content: any[] = images.map((src) => {
    const [head, data] = src.split(",");
    return { type: "image", source: { type: "base64", media_type: head.slice(5, head.indexOf(";")), data } };
  });
  if (text.trim()) content.push({ type: "text", text });
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId ?? "" };
}

export function permissionReply(req: PermissionRequest, decision: "allow" | "always" | "deny") {
  const response =
    decision === "deny"
      ? { behavior: "deny", message: "用户拒绝了这次操作" }
      : {
          behavior: "allow",
          updatedInput: req.input,
          ...(decision === "always" && req.suggestions ? { updatedPermissions: req.suggestions } : {}),
        };
  return { type: "control_response", response: { subtype: "success", request_id: req.requestId, response } };
}

/** 允许并替换工具参数：AskUserQuestion 的答案就是放在 updatedInput.answers 里回传的 */
export function permissionAllow(req: PermissionRequest, updatedInput: Record<string, any>) {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: req.requestId, response: { behavior: "allow", updatedInput } },
  };
}

/** 拒绝并把理由告诉 Claude（如计划的修改意见） */
export function permissionDeny(req: PermissionRequest, message: string) {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: req.requestId, response: { behavior: "deny", message } },
  };
}

export function controlRequest(request: Record<string, any>) {
  return { type: "control_request", request_id: crypto.randomUUID(), request };
}

const INIT_PREFIX = "init-";
const MCP_STATUS_PREFIX = "mcp-status-";
export const MCP_ACTION_PREFIX = "mcp-act-";

export interface McpServer {
  name: string;
  /** connected / failed / needs-auth / pending / disabled */
  status: string;
  error?: string;
  /** 配置来源：user / project / local 等 */
  scope?: string;
  version?: string;
  tools?: string[];
}

function parseServer(m: any): McpServer {
  return {
    name: m.name,
    status: m.status,
    error: m.error || undefined,
    scope: m.scope ?? m.config?.scope,
    version: m.serverInfo?.version,
    tools: Array.isArray(m.tools) ? m.tools.map((t: any) => (typeof t === "string" ? t : t.name)) : undefined,
  };
}

/** init 只带名字和状态，保留 mcp_status 拿到的其余字段 */
function mergeServers(prev: McpServer[], list: any[]): McpServer[] {
  return list.map((m) => ({ ...prev.find((p) => p.name === m.name), ...parseServer(m) }));
}

/** 查询 MCP 服务器详细状态（对应 Agent SDK 的 mcpServerStatus） */
export function mcpStatusRequest() {
  return { type: "control_request", request_id: MCP_STATUS_PREFIX + crypto.randomUUID(), request: { subtype: "mcp_status" } };
}

/** 重连 / 启停某个 MCP 服务器；成功后调用方再查一次状态 */
export function mcpActionRequest(serverName: string, enabled?: boolean) {
  const request = enabled === undefined ? { subtype: "mcp_reconnect", serverName } : { subtype: "mcp_toggle", serverName, enabled };
  return { type: "control_request", request_id: MCP_ACTION_PREFIX + crypto.randomUUID(), request };
}

/** 某个服务器提供的工具：优先用 mcp_status 的列表，否则按工具名前缀 mcp__服务器__ 从 init 里筛 */
export function serverTools(server: McpServer, tools: string[]): string[] {
  if (server.tools) return server.tools;
  const prefix = `mcp__${server.name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
  return tools.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
}

/** 启动后的 initialize 请求：id 带固定前缀，失败时能认出来并忽略 */
export function initializeRequest() {
  return { type: "control_request", request_id: INIT_PREFIX + crypto.randomUUID(), request: { subtype: "initialize" } };
}
