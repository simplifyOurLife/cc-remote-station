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
  /** 允许该主机上的 Claude Code 经反向转发使用本机 MCP */
  mcp: boolean;
  /** 这台主机用的工具及在这台主机上改过的云端名字/端口；null 表示只用内置工具 */
  tools?: HostTool[] | null;
  /** 侧栏分组名，null 表示未分组 */
  group: string | null;
  /** 默认工作目录（云主机路径），新终端和新对话从这里开始 */
  dir: string | null;
}

/** 主机上的一个工具：alias / remotePort 为空表示用工具箱里的默认值 */
export interface HostTool {
  name: string;
  alias: string;
  remotePort: number | null;
}

export interface Settings {
  token: string;
  roots: string[];
  allowCommands: boolean;
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

/** 工具显示的名字：内置工具内部 id 是 ccws，显示为 cc-workstation */
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
export const BUILTIN_CLOUD_NAME = "cc-workstation";

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
  /** 这台主机勾选的工具应配的地址 */
  wanted: { name: string; cloudName: string; url: string | null; error: string | null }[];
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
  forwards: ForwardState[];
}

/** 主机的转发总体状态：有一条失败就算 error；未连接为 null */
export function forwardState(st: McpHostStatus | undefined): "ok" | "error" | null {
  if (!st) return null;
  return st.forwards.some((f) => f.error) ? "error" : "ok";
}

/** 逐条列出映射，用于提示文字 */
export function describeForwards(st: McpHostStatus): string {
  return st.forwards
    .map((f) => `${f.error ? "✕" : "✓"} ${f.name}：云端 127.0.0.1:${f.remotePort} → 本机 ${f.target}${f.error ? `\n   ${f.error}` : ""}`)
    .join("\n");
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

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ChatStartArgs {
  hostId: string;
  cwd: string;
  resume: string | null;
  /** 与 resume 同时使用：在新会话里接着聊，原会话不变 */
  fork: boolean;
  model: string | null;
  permissionMode: PermissionMode;
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

export const api = {
  hostsList: () => invoke<Host[]>("hosts_list"),
  /** secret: undefined 不改；"" 删除；其他写入系统凭据管理器 */
  hostSave: (host: Host, secret?: string) => invoke<Host>("host_save", { host, secret }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  terminalOpen: (hostId: string, cols: number, rows: number, opts: OpenOptions, onData: Channel<ArrayBuffer>) =>
    invoke<{ id: string; notice: string | null }>("terminal_open", { hostId, cols, rows, ...opts, onData }),
  terminalWrite: (id: string, data: Uint8Array) =>
    invoke<void>("terminal_write", { id, data: Array.from(data) }),
  terminalResize: (id: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { id, cols, rows }),
  terminalClose: (id: string, killSession = false) => invoke<void>("terminal_close", { id, killSession }),
  notify: (title: string, body: string) => invoke<void>("notify", { title, body }),
  /** 剪贴板有图片则上传到远端并返回路径，没有图片返回 null */
  terminalPasteImage: (id: string) => invoke<string | null>("terminal_paste_image", { id }),
  tmuxSessions: (hostId: string) => invoke<TmuxSession[]>("tmux_sessions", { hostId }),
  tmuxKill: (hostId: string, name: string) => invoke<void>("tmux_kill", { hostId, name }),
  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSave: (patch: Pick<Settings, "roots" | "allowCommands" | "remotePort" | "device" | "builtinAlias">) => invoke<Settings>("settings_save", { patch }),
  settingsRegenToken: () => invoke<Settings>("settings_regen_token"),
  toolboxSave: (items: ToolboxItem[]) => invoke<ToolboxItem[]>("toolbox_save", { items }),
  /** 用表单里的配置试连一次（不必先保存） */
  toolboxTest: (item: ToolboxItem) => invoke<ToolboxTest>("toolbox_test", { item }),
  toolboxBuiltin: () => invoke<ToolBrief[]>("toolbox_builtin"),
  /** 内置服务在本机监听的端口 */
  mcpLocalPort: () => invoke<number>("mcp_local_port"),
  /** 读云端 ~/.claude.json 里的 MCP 配置并和应配的对比；没连接会自动连上。dir 为 null 只看全局 */
  claudeMcpState: (hostId: string, dir: string | null) => invoke<ClaudeMcpState>("claude_mcp_state", { hostId, dir }),
  /** dir 为 null 写全局（user），否则写该项目（local） */
  claudeMcpApply: (hostId: string, dir: string | null, add: string[], remove: string[]) =>
    invoke<string>("claude_mcp_apply", { hostId, dir, add, remove }),
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
  chatFiles: (hostId: string, cwd: string) => invoke<string[]>("chat_files", { hostId, cwd }),
  chatDelete: (hostId: string, file: string) => invoke<void>("chat_delete", { hostId, file }),
  saveText: (path: string, text: string) => invoke<void>("save_text", { path, text }),
  /** 把本机文件传到云主机，返回远端路径 */
  chatUpload: (hostId: string, path: string) => invoke<string>("chat_upload", { hostId, path }),
};

/** 主机用的工具；从没配过时只有内置工具 */
export function hostTools(h: Host): HostTool[] {
  return h.tools ?? [{ name: BUILTIN_NAME, alias: "", remotePort: null }];
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
