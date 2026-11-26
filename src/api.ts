import { Channel, invoke } from "@tauri-apps/api/core";

export type Auth = { kind: "password" } | { kind: "key"; path: string } | { kind: "agent" };

export interface Host {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: Auth;
  jump: string | null;
  /** 远端 tmux 托底：断线后会话不死，重连自动接回 */
  tmux: boolean;
  /** 主机上装了 Claude Code；false 时只当 SSH 主机用：不提供对话，也不转发 MCP */
  claude: boolean;
  /** 允许该主机上的 Claude Code 经反向转发使用本机 MCP */
  mcp: boolean;
  /** 打开应用就建立端口映射；否则第一次连这台主机时再建 */
  mcpAutostart?: boolean;
  /** 这台主机转发的工具及在这台主机上改过的云端端口；null 表示只转发内置工具 */
  tools?: HostTool[] | null;
  /** 侧栏分组名，null 表示未分组 */
  group: string | null;
  /** 默认工作目录（云主机路径），新终端和新对话从这里开始 */
  dir: string | null;
  /** 这台主机上的 Claude 执行本机命令的管控模式；null 跟随全局 */
  commandMode?: CommandMode | null;
}

/** 云端执行本机命令的管控模式 */
export type CommandMode = "off" | "confirm" | "allowlist" | "all";

export const COMMAND_MODES: { value: CommandMode; label: string; hint: string }[] = [
  { value: "off", label: "关闭", hint: "不允许执行命令" },
  { value: "confirm", label: "每条确认", hint: "每条命令都在本机弹窗确认，60 秒无人处理则拒绝" },
  { value: "allowlist", label: "白名单 + 确认", hint: "白名单里的直接执行，其余弹窗确认" },
  { value: "all", label: "全部允许", hint: "不确认直接执行，只用于完全信任的主机" },
];

export const commandModeLabel = (m: CommandMode) => COMMAND_MODES.find((x) => x.value === m)?.label ?? m;

/** 主机转发的一个工具：remotePort 为空表示用工具箱里的默认映射端口 */
export interface HostTool {
  name: string;
  remotePort: number | null;
}

/** settings_save 接收的字段 */
export type SettingsField = "roots" | "commandMode" | "commandAllowlist" | "remotePort" | "device" | "builtinAlias";

export interface Settings {
  token: string;
  roots: string[];
  /** 云端执行本机命令的全局模式；主机可单独设 */
  commandMode: CommandMode;
  /** 白名单：按词匹配命令开头，如 git、npm run build */
  commandAllowlist: string[];
  remotePort: number;
  /** 这台电脑的标识；设了就加在云端 MCP 名字后面（ccws-home），多台电脑连同一主机不互相覆盖 */
  device: string;
  /** 内置工具在云端的自定义名字；空为默认 */
  builtinAlias: string;
  toolbox: ToolboxItem[];
}

/** 工具在云端 Claude Code 里的名字：自定义名字优先，否则 名字[-电脑标识]（和后端 Settings::cloud_name 一致） */
export function defaultCloudName(name: string, device: string) {
  const base = toolLabel(name);
  return device ? `${base}-${device}` : base;
}

/** 工具显示的名字：内置工具内部 id 是 ccws，显示为 cc-remote-station */
export function toolLabel(name: string) {
  return name === BUILTIN_NAME ? BUILTIN_CLOUD_NAME : name;
}

export function cloudNameOf(s: Pick<Settings, "device" | "builtinAlias" | "toolbox">, name: string) {
  const alias = name === BUILTIN_NAME ? s.builtinAlias : s.toolbox.find((i) => i.name === name)?.alias;
  return alias || defaultCloudName(name, s.device);
}

/** 内置工具的内部 id（主机保存的工具列表里用它） */
export const BUILTIN_NAME = "ccws";
/** 内置工具显示的名字，也是默认的云端名字 */
export const BUILTIN_CLOUD_NAME = "cc-remote-station";

export interface KeyValue {
  key: string;
  value: string;
}

export type ToolSource =
  | { kind: "stdio"; command: string; args: string[]; env: KeyValue[]; cwd: string | null }
  | { kind: "http"; url: string; headers: KeyValue[]; legacySse: boolean };

/** MCP 工具箱里的一个服务：挂在本机内置服务的 /mcp/<name> 下转发给云端 */
export type ToolboxItem = {
  name: string;
  enabled: boolean;
  /** 云主机上监听的端口，反向转发到本机目标 */
  remotePort: number;
  /** 在云端 Claude Code 里的自定义名字；空为默认 */
  alias: string;
} & ToolSource;

/** 本机配置里找到的 MCP；source 为 null 时 skipped 是跳过原因 */
export interface ImportCandidate {
  origin: string;
  name: string;
  source: ToolSource | null;
  skipped: string | null;
}

export interface ToolBrief {
  name: string;
  description: string;
}

export interface ToolboxTest {
  server: string;
  tools: ToolBrief[];
}

export interface TrustedKey {
  host: string;
  port: number;
  fingerprint: string;
}

export interface NeedSecret {
  hostId: string;
  hostName: string;
  kind: "password" | "passphrase";
  /** 刚才试过的密码不对 */
  wrong: boolean;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  /** 最后活动时间，Unix 秒 */
  activity: number;
}

/** 一条审计记录（也是 mcp-activity 事件的载荷） */
export interface AuditEntry {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error: string | null;
  ms: number;
}

export interface BackupEntry {
  id: string;
  original: string;
  reason: string;
  ts: string;
  size: number;
}

export interface ClaudeMcpState {
  /** 解析成绝对路径的项目目录；全局时为 null */
  dir: string | null;
  /** 云端 Claude 打开过的项目目录 */
  projects: string[];
  /** 全局已配置的 MCP：名字 → 地址 */
  global: Record<string, string>;
  /** 所选项目已配置的 MCP */
  project: Record<string, string>;
  /** 这台主机转发的工具应配的地址；defaultName 是工具箱里的默认映射名称 */
  wanted: { name: string; defaultName: string; url: string | null; error: string | null }[];
}

/** 一条工具箱端口映射在某台主机上的建立结果 */
export interface ForwardState {
  name: string;
  remotePort: number;
  /** 本机一侧的 host:port */
  target: string;
  /** null 表示已建立 */
  error: string | null;
}

export interface McpHostStatus {
  hostId: string;
  /** own：独立的转发连接；shared：借用终端/对话的连接；空串：还没连上 */
  mode: "own" | "shared" | "";
  /** 没连上时的原因 */
  note: string | null;
  forwards: ForwardState[];
}

/** 主机的转发总体状态：有一条失败就算 error；还没连上为 wait；没启动映射为 null */
export function forwardState(st: McpHostStatus | undefined): "ok" | "error" | "wait" | null {
  if (!st) return null;
  if (!st.mode) return "wait";
  return st.forwards.some((f) => f.error) ? "error" : "ok";
}

/** 逐条列出映射，用于提示文字 */
export function describeForwards(st: McpHostStatus): string {
  if (!st.mode) return st.note ?? "正在连接";
  const via = st.mode === "own" ? "走独立连接" : "借用终端/对话的连接";
  const lines = st.forwards.map(
    (f) => `${f.error ? "✕" : "✓"} ${f.name}：云端 127.0.0.1:${f.remotePort} → 本机 ${f.target}${f.error ? `\n   ${f.error}` : ""}`,
  );
  return [via, ...lines].join("\n");
}

/** 图形版 /config：可设的键（CLI 用法说明原文）和几份配置文件的内容（读不到为 null） */
export interface ClaudeConfig {
  usage: string;
  user: Record<string, any> | null;
  project: Record<string, any> | null;
  local: Record<string, any> | null;
  global: Record<string, any> | null;
}

export interface HostCheck {
  /** claude --version 的输出；没装为 null */
  claude: string | null;
  loggedIn: boolean;
  tmux: boolean;
}

export interface ChatSession {
  /** ~/.claude/projects 下的相对路径 */
  file: string;
  sessionId: string;
  cwd: string;
  title: string;
  /** 最后修改时间，Unix 秒 */
  mtime: number;
}

/** 历史会话的本机缓存 */
export interface ChatCacheInfo {
  /** 当前使用的目录 */
  dir: string;
  defaultDir: string;
  bytes: number;
  sessions: number;
}

/** 在终端里接着聊这个会话的命令：-p 跑出的会话不出现在 claude --resume 的列表里，要在会话目录下按 id 恢复 */
export const resumeCommand = (s: ChatSession) => `cd '${s.cwd.replace(/'/g, `'\\''`)}' && claude --resume ${s.sessionId}`;

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ChatStartArgs {
  hostId: string;
  cwd: string;
  resume: string | null;
  /** 与 resume 同时使用：在新会话里接着聊，原会话不变 */
  fork: boolean;
  model: string | null;
  permissionMode: PermissionMode;
  /** 每轮结束后预测下一句（prompt_suggestion 事件） */
  promptSuggestions: boolean;
}

export type CmdError =
  | ({ code: "hostKeyUnknown" } & TrustedKey)
  | ({ code: "needSecret" } & NeedSecret)
  | { code: "failed"; message: string };

export interface OpenOptions {
  trust: TrustedKey | null;
  /** 弹窗里临时输入的密码/口令，按主机 id（含跳板机） */
  secrets: Record<string, string>;
  /** 认证成功后把 secrets 存入系统凭据管理器 */
  remember: boolean;
  session: string | null;
}

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string;
  date: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export const api = {
  hostsList: () => invoke<Host[]>("hosts_list"),
  /** secret: undefined 不改；"" 删除；其他写入系统凭据管理器 */
  hostSave: (host: Host, secret?: string) => invoke<Host>("host_save", { host, secret }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  terminalOpen: (hostId: string, cols: number, rows: number, opts: OpenOptions, onData: Channel<ArrayBuffer>) =>
    invoke<string>("terminal_open", { hostId, cols, rows, ...opts, onData }),
  terminalWrite: (id: string, data: Uint8Array) =>
    invoke<void>("terminal_write", { id, data: Array.from(data) }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: string, killSession = false) => invoke<void>("terminal_close", { id, killSession }),
  /** 回答登录中途的验证码弹窗；null 表示取消 */
  sshPromptAnswer: (id: string, answers: string[] | null) => invoke<void>("ssh_prompt_answer", { id, answers }),
  /** 检查云主机环境：claude 是否安装、是否登录、有没有 tmux；没连接会自动连上 */
  hostCheck: (hostId: string) => invoke<HostCheck>("host_check", { hostId }),
  /** 检查新版本；proxy 为空走系统代理；没有新版本返回 null */
  updateCheck: (proxy: string) => invoke<UpdateInfo | null>("update_check", { proxy }),
  /** 下载并安装刚检查到的版本，完成后应用重启 */
  updateInstall: (onProgress: (p: UpdateProgress) => void) => {
    const ch = new Channel<UpdateProgress>();
    ch.onmessage = onProgress;
    return invoke<void>("update_install", { onProgress: ch });
  },
  /** 回答命令确认弹窗；always 时 rule 加进白名单 */
  commandConfirmAnswer: (id: string, decision: "once" | "always" | "deny", rule: string | null) =>
    invoke<void>("command_confirm_answer", { id, decision, rule }),
  notify: (title: string, body: string) => invoke<void>("notify", { title, body }),
  /** 剪贴板有图片则上传到远端并返回路径，没有图片返回 null */
  terminalPasteImage: (id: string) => invoke<string | null>("terminal_paste_image", { id }),
  tmuxSessions: (hostId: string) => invoke<TmuxSession[]>("tmux_sessions", { hostId }),
  tmuxKill: (hostId: string, name: string) => invoke<void>("tmux_kill", { hostId, name }),
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSave: (patch: Pick<Settings, SettingsField>) => invoke<Settings>("settings_save", { patch }),
  settingsRegenToken: () => invoke<Settings>("settings_regen_token"),
  toolboxSave: (items: ToolboxItem[]) => invoke<ToolboxItem[]>("toolbox_save", { items }),
  toolboxImportScan: () => invoke<ImportCandidate[]>("toolbox_import_scan"),
  /** 用表单里的配置试连一次（不必先保存） */
  toolboxTest: (item: ToolboxItem) => invoke<ToolboxTest>("toolbox_test", { item }),
  toolboxBuiltin: () => invoke<ToolBrief[]>("toolbox_builtin"),
  /** 内置服务在本机监听的端口 */
  mcpLocalPort: () => invoke<number>("mcp_local_port"),
  /** 读云端 ~/.claude.json 里的 MCP 配置并和应配的对比；没连接会自动连上。dir 为 null 只看全局 */
  claudeMcpState: (hostId: string, dir: string | null) => invoke<ClaudeMcpState>("claude_mcp_state", { hostId, dir }),
  /** dir 为 null 写全局（user），否则写该项目（local）；remove 是 Claude 里已有的名字 */
  claudeMcpApply: (hostId: string, dir: string | null, add: { name: string; cloudName: string }[], remove: string[]) =>
    invoke<string>("claude_mcp_apply", { hostId, dir, add, remove }),
  claudeConfigRead: (hostId: string, dir: string) => invoke<ClaudeConfig>("claude_config_read", { hostId, dir }),
  claudeConfigSet: (hostId: string, dir: string, key: string, value: string) =>
    invoke<string>("claude_config_set", { hostId, dir, key, value }),
  quotaLog: (hostId: string, lines: string) => invoke<void>("quota_log", { hostId, lines }),
  uiPrefsGet: () => invoke<Record<string, unknown>>("ui_prefs_get"),
  uiPrefsSet: (prefs: unknown) => invoke<void>("ui_prefs_set", { prefs }),
  sshConfigRead: () => invoke<string>("ssh_config_read"),
  auditDays: () => invoke<string[]>("audit_days"),
  auditEntries: (day: string) => invoke<AuditEntry[]>("audit_entries", { day }),
  backupsList: () => invoke<BackupEntry[]>("backups_list"),
  backupRestore: (id: string) => invoke<string>("backup_restore", { id }),
  mcpStatus: () => invoke<McpHostStatus[]>("mcp_status"),
  chatStart: (args: ChatStartArgs, onEvent: Channel<Record<string, any>>) =>
    invoke<string>("chat_start", { args, onEvent }),
  chatSend: (id: string, message: unknown) => invoke<void>("chat_send", { id, message }),
  chatStop: (id: string) => invoke<void>("chat_stop", { id }),
  /** dir 有值只读该工作目录的会话；null 扫全部目录最近的会话 */
  chatSessions: (hostId: string, dir: string | null) => invoke<ChatSession[]>("chat_sessions", { hostId, dir }),
  /** 云主机的时区：对话里的时间按 Claude 运行的地方显示 */
  hostTimezone: (hostId: string) => invoke<{ iana: string | null; offsetMin: number }>("host_timezone", { hostId }),
  /** 云端 Claude 最近用过的工作目录（新的在前） */
  chatDirs: (hostId: string) => invoke<string[]>("chat_dirs", { hostId }),
  chatHistory: (hostId: string, file: string) => invoke<Record<string, any>[]>("chat_history", { hostId, file }),
  chatHistoryCached: (hostId: string, file: string) => invoke<Record<string, any>[] | null>("chat_history_cached", { hostId, file }),
  chatCacheInfo: () => invoke<ChatCacheInfo>("chat_cache_info"),
  chatCacheSetDir: (dir: string | null) => invoke<ChatCacheInfo>("chat_cache_set_dir", { dir }),
  chatCacheClear: () => invoke<ChatCacheInfo>("chat_cache_clear"),
  chatFiles: (hostId: string, cwd: string) => invoke<string[]>("chat_files", { hostId, cwd }),
  chatDelete: (hostId: string, file: string) => invoke<void>("chat_delete", { hostId, file }),
  saveText: (path: string, text: string) => invoke<void>("save_text", { path, text }),
  /** 把本机文件传到云主机，返回远端路径 */
  chatUpload: (hostId: string, path: string) => invoke<string>("chat_upload", { hostId, path }),
};

/** 主机用的工具；从没配过时只有内置工具 */
export function hostTools(h: Host): HostTool[] {
  return h.tools ?? [{ name: BUILTIN_NAME, remotePort: null }];
}

/** 主机用的工具名 */
export function hostToolbox(h: Host): string[] {
  return hostTools(h).map((t) => t.name);
}

export function errorText(e: unknown): string {
  const err = e as CmdError;
  if (err?.code === "failed") return err.message;
  if (err?.code === "needSecret") return `${err.hostName} 需要${err.kind === "password" ? "密码" : "私钥口令"}，请先打开终端连接并输入`;
  if (err?.code === "hostKeyUnknown") return `尚未信任 ${err.host} 的主机密钥，请先打开终端连接确认`;
  return String(e);
}
