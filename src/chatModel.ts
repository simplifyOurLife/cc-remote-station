/** Claude Code stream-json 协议的前端模型：把事件归并成可渲染的消息列表 */

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, any> }
  | { type: "image"; src: string };

export type Item =
  | { kind: "user"; key: string; blocks: Block[] }
  | { kind: "assistant"; key: string; messageId: string; blocks: Block[] }
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

export interface Usage {
  costUsd: number;
  contextUsed: number;
  contextWindow: number;
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
  slashCommands: string[];
  /** 云端 claude 加载的 MCP 服务器及状态（来自 init） */
  mcpServers: { name: string; status: string }[];
  usage: Usage | null;
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
  mcpServers: [],
  usage: null,
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
function addUser(s: ChatState, content: any): ChatState {
  const results = { ...s.results };
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "tool_result") results[b.tool_use_id] = { text: resultText(b.content), isError: !!b.is_error };
    }
  }
  const blocks = toBlocks(Array.isArray(content) ? content.filter((b: any) => b.type !== "tool_result") : content);
  const items = blocks.length ? [...s.items, { kind: "user" as const, key: key(), blocks }] : s.items;
  return { ...s, results, items };
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
  return { ...s, running: true, items: [...s.items, { kind: "user", key: key(), blocks }] };
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
          slashCommands: e.slash_commands ?? s.slashCommands,
          mcpServers: e.mcp_servers ?? s.mcpServers,
        };
      }
      if (e.subtype === "compact_boundary") {
        const before = e.compact_metadata?.pre_tokens;
        return system(s, `上下文已压缩${before ? `（压缩前约 ${Math.round(before / 1000)}k tokens）` : ""}，更早的细节 Claude 可能记不清了`);
      }
      return s;
    case "stream_event": {
      // 子代理的流式片段不显示在主对话里
      if (e.parent_tool_use_id) return s;
      const ev = e.event ?? {};
      if (ev.type === "message_start") return { ...s, streaming: "" };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        return { ...s, streaming: s.streaming + ev.delta.text };
      }
      return s;
    }
    case "assistant":
      return { ...s, streaming: "", items: addAssistant(s.items, e.message?.id ?? key(), toBlocks(e.message?.content)) };
    case "user":
      return addUser(s, e.message?.content);
    case "result": {
      const usage = usageOf(e) ?? s.usage;
      const next = { ...s, running: false, streaming: "", usage };
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
    case "control_response":
      if (e.response?.subtype === "error") return system(s, `操作未生效：${e.response.error}`, "error");
      return s;
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

/** 用量：花费取本会话累计；上下文取 modelUsage 里输入 token 最多的那个模型 */
function usageOf(e: Record<string, any>): Usage | null {
  const models = Object.values(e.modelUsage ?? {}) as any[];
  if (!models.length) return null;
  const main = models.reduce((a, b) => ((b.inputTokens ?? 0) > (a.inputTokens ?? 0) ? b : a));
  return {
    costUsd: e.total_cost_usd ?? 0,
    contextUsed: (main.inputTokens ?? 0) + (main.cacheReadInputTokens ?? 0) + (main.outputTokens ?? 0),
    contextWindow: main.contextWindow ?? 0,
  };
}

/** 把会话 jsonl 的历史行转成初始状态（用于继续历史会话时回显） */
export function fromHistory(lines: Record<string, any>[]): ChatState {
  let s = emptyState;
  for (const l of lines) {
    if (l.isMeta || l.isSidechain) continue;
    if (l.type === "user") s = addUser(s, l.message?.content);
    else if (l.type === "assistant") s = { ...s, items: addAssistant(s.items, l.message?.id ?? key(), toBlocks(l.message?.content)) };
  }
  return s;
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
