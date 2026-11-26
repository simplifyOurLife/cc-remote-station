import { FormEvent, useState } from "react";
import { api, Auth, BUILTIN_NAME, errorText, Host } from "./api";
import { NumberInput } from "./NumberInput";
import { Combo, Select } from "./Select";

const emptyHost: Host = { id: "", name: "", host: "", port: 22, user: "root", auth: { kind: "password" }, jump: null, tmux: false, claude: true, mcp: true, tools: [{ name: BUILTIN_NAME, remotePort: null }], group: null, dir: null };

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
    <div className="terminal-overlay" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <form className="dialog host-form" onSubmit={submit}>
        <h3>{isNew ? "新建主机" : `编辑 ${initial.name}`}</h3>
        <label>
          名称：
          <input value={host.name} onChange={(e) => set({ name: e.target.value })} placeholder="留空则用 user@host" />
        </label>
        <label>
          分组：
          <Combo
            value={host.group ?? ""}
            onChange={(v) => set({ group: v || null })}
            options={[...new Set(hosts.map((h) => h.group).filter((g): g is string => !!g))].map((g) => ({ value: g }))}
            placeholder="可选，如：生产 / 测试"
          />
        </label>
        <div className="row">
          <label className="grow">
            主机：
            <input required value={host.host} onChange={(e) => set({ host: e.target.value.trim() })} />
          </label>
          <label className="port">
            端口：
            <NumberInput required min={1} max={65535} value={host.port} onChange={(port) => set({ port })} />
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
          <Select
            value={host.auth.kind}
            onChange={setAuthKind}
            options={[
              { value: "password", label: "密码" },
              { value: "key", label: "私钥文件" },
              { value: "agent", label: "ssh-agent / Pageant", hint: "用本机已加载的密钥" },
            ]}
          />
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
          <Select
            value={host.jump ?? ""}
            onChange={(v) => set({ jump: v || null })}
            options={[
              { value: "", label: "无，直接连接" },
              ...hosts.filter((h) => h.id !== host.id).map((h) => ({ value: h.id, label: h.name, hint: h.host })),
            ]}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={host.claude}
            // 没装 Claude Code 时 MCP 转发没人用，一并关掉；重新勾上时恢复默认的转发
            onChange={(e) => set({ claude: e.target.checked, mcp: e.target.checked })}
          />
          已安装 Claude Code：不勾则只当 SSH 主机用，不显示「开始对话」，也不转发 MCP 工具
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={host.tmux} onChange={(e) => set({ tmux: e.target.checked })} />
          保持会话（tmux）：断线后终端不中断，重连自动接回；需服务器已装 tmux
        </label>
        {host.claude && (
          <label className="checkbox">
            <input type="checkbox" checked={host.mcp} onChange={(e) => set({ mcp: e.target.checked })} />
            连接时转发 MCP 工具：具体转发哪些、注册到 Claude，在主机卡片的「MCP 转发」里设置
          </label>
        )}
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
