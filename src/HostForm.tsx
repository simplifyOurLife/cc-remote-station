import { FormEvent, useState } from "react";
import { api, Auth, errorText, Host } from "./api";

const emptyHost: Host = { id: "", name: "", host: "", port: 22, user: "root", auth: { kind: "password" }, jump: null, tmux: false, mcp: true, group: null, dir: null };

export function HostForm({
  initial,
  hosts,
  onSaved,
  onCancel,
}: {
  initial: Host | null;
  hosts: Host[];
  onSaved: (h: Host) => void;
  onCancel: () => void;
}) {
  const [host, setHost] = useState<Host>(initial ?? emptyHost);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const isNew = !initial;
  const set = (patch: Partial<Host>) => setHost((h) => ({ ...h, ...patch }));
  const setAuthKind = (kind: Auth["kind"]) =>
    set({ auth: kind === "key" ? { kind, path: "~/.ssh/id_ed25519" } : { kind } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const name = host.name.trim() || `${host.user}@${host.host}`;
      // 编辑时留空表示不改已保存的密码/口令；agent 认证不需要凭据，顺手清掉
      const secretArg = host.auth.kind === "agent" ? "" : secret || undefined;
      const group = host.group?.trim() || null;
      const dir = host.dir?.trim() || null;
      onSaved(await api.hostSave({ ...host, name, group, dir }, secretArg));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const secretLabel = host.auth.kind === "password" ? "密码" : "私钥口令";

  return (
    <div className="terminal-overlay">
      <form className="dialog host-form" onSubmit={submit}>
        <h3>{isNew ? "新建主机" : `编辑 ${initial.name}`}</h3>
        <label>
          名称：
          <input value={host.name} onChange={(e) => set({ name: e.target.value })} placeholder="留空则用 user@host" />
        </label>
        <label>
          分组：
          <input
            list="host-groups"
            value={host.group ?? ""}
            onChange={(e) => set({ group: e.target.value || null })}
            placeholder="可选，如：生产 / 测试"
          />
          <datalist id="host-groups">
            {[...new Set(hosts.map((h) => h.group).filter(Boolean))].map((g) => (
              <option key={g} value={g!} />
            ))}
          </datalist>
        </label>
        <div className="row">
          <label className="grow">
            主机：
            <input required value={host.host} onChange={(e) => set({ host: e.target.value.trim() })} />
          </label>
          <label className="port">
            端口：
            <input type="number" required min={1} max={65535} value={host.port} onChange={(e) => set({ port: Number(e.target.value) })} />
          </label>
        </div>
        <label>
          默认工作目录：
          <input
            value={host.dir ?? ""}
            onChange={(e) => set({ dir: e.target.value || null })}
            placeholder="可选，如 ~/projects/a；新终端和新对话都从这里开始"
          />
        </label>
        <label>
          用户名：
          <input required value={host.user} onChange={(e) => set({ user: e.target.value.trim() })} />
        </label>
        <label>
          认证方式：
          <select value={host.auth.kind} onChange={(e) => setAuthKind(e.target.value as Auth["kind"])}>
            <option value="password">密码</option>
            <option value="key">私钥文件</option>
            <option value="agent">ssh-agent / Pageant</option>
          </select>
        </label>
        {host.auth.kind === "key" && (
          <label>
            私钥路径：
            <input required value={host.auth.path} onChange={(e) => set({ auth: { kind: "key", path: e.target.value } })} />
          </label>
        )}
        {host.auth.kind !== "agent" && (
          <label>
            {secretLabel}：
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={isNew ? (host.auth.kind === "key" ? "无口令可留空" : "") : "留空则不修改"}
            />
          </label>
        )}
        <label>
          跳板机：
          <select value={host.jump ?? ""} onChange={(e) => set({ jump: e.target.value || null })}>
            <option value="">无</option>
            {hosts
              .filter((h) => h.id !== host.id)
              .map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={host.tmux} onChange={(e) => set({ tmux: e.target.checked })} />
          保持会话（tmux）：断线后 Claude Code 不中断，重连自动接回；需服务器已装 tmux
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={host.mcp} onChange={(e) => set({ mcp: e.target.checked })} />
          允许访问本机：这台主机上的 Claude Code 可经 SSH 隧道操作本机白名单目录（MCP）
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary">
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
