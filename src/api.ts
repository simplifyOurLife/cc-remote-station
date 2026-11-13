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
  /** 侧栏分组名，null 表示未分组 */
  group: string | null;
  /** 默认工作目录（云主机路径），新终端和新对话从这里开始 */
  dir: string | null;
}

export interface Settings {
  token: string;
  roots: string[];
  allowCommands: boolean;
  remotePort: number;
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

export interface McpHostStatus {
  hostId: string;
  state: "ok" | "error";
  detail: string;
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
  settingsSave: (patch: Omit<Settings, "token">) => invoke<Settings>("settings_save", { patch }),
  settingsRegenToken: () => invoke<Settings>("settings_regen_token"),
  /** 在云主机上执行 claude mcp add，需该主机已有连接 */
  hostSetupClaude: (hostId: string) => invoke<string>("host_setup_claude", { hostId }),
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
  chatSessions: (hostId: string) => invoke<ChatSession[]>("chat_sessions", { hostId }),
  chatHistory: (hostId: string, file: string) => invoke<Record<string, any>[]>("chat_history", { hostId, file }),
  chatFiles: (hostId: string, cwd: string) => invoke<string[]>("chat_files", { hostId, cwd }),
  chatDelete: (hostId: string, file: string) => invoke<void>("chat_delete", { hostId, file }),
  saveText: (path: string, text: string) => invoke<void>("save_text", { path, text }),
  /** 把本机文件传到云主机，返回远端路径 */
  chatUpload: (hostId: string, path: string) => invoke<string>("chat_upload", { hostId, path }),
};

export function errorText(e: unknown): string {
  const err = e as CmdError;
  if (err?.code === "failed") return err.message;
  if (err?.code === "needSecret") return `${err.hostName} 需要${err.kind === "password" ? "密码" : "私钥口令"}，请先打开终端连接并输入`;
  if (err?.code === "hostKeyUnknown") return `尚未信任 ${err.host} 的主机密钥，请先打开终端连接确认`;
  return String(e);
}
