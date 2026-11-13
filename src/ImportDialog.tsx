import { useEffect, useState } from "react";
import { api, errorText, Host } from "./api";

interface Entry {
  alias: string;
  hostName: string;
  user: string;
  port: number;
  identityFile: string | null;
  proxyJump: string | null;
}

/** 解析 ~/.ssh/config：只取具体主机块（跳过含通配符的 Host），关键字不区分大小写 */
function parseSshConfig(text: string): Entry[] {
  const entries: Entry[] = [];
  let current: Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      current = value
        .split(/\s+/)
        .filter((a) => !/[*?!]/.test(a))
        .map((alias) => ({ alias, hostName: alias, user: "root", port: 22, identityFile: null, proxyJump: null }));
      entries.push(...current);
    } else if (key === "match") {
      current = [];
    } else {
      for (const e of current) {
        if (key === "hostname") e.hostName = value;
        else if (key === "user") e.user = value;
        else if (key === "port") e.port = Number(value) || 22;
        else if (key === "identityfile" && !e.identityFile) e.identityFile = value;
        else if (key === "proxyjump") e.proxyJump = value.split(",")[0];
      }
    }
  }
  return entries;
}

export function ImportDialog({ hosts, onDone, onClose }: { hosts: Host[]; onDone: () => void; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const exists = (e: Entry) => hosts.some((h) => h.name === e.alias || (h.host === e.hostName && h.user === e.user && h.port === e.port));

  useEffect(() => {
    api.sshConfigRead().then((text) => {
      const list = parseSshConfig(text);
      setEntries(list);
      setPicked(new Set(list.filter((e) => !exists(e)).map((e) => e.alias)));
    });
  }, []);

  const toggle = (alias: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });

  const doImport = async () => {
    try {
      const chosen = entries!.filter((e) => picked.has(e.alias));
      // 先分配 id，跳板机引用才能指向同批导入的主机；也支持指向已有的同名主机
      const ids = new Map<string, string>(chosen.map((e) => [e.alias, crypto.randomUUID()]));
      for (const h of hosts) if (!ids.has(h.name)) ids.set(h.name, h.id);
      for (const e of chosen) {
        const host: Host = {
          id: ids.get(e.alias)!,
          name: e.alias,
          host: e.hostName,
          port: e.port,
          user: e.user,
          // 没写 IdentityFile 时 OpenSSH 会试 agent 和默认密钥，这里对应用 agent
          auth: e.identityFile ? { kind: "key", path: e.identityFile } : { kind: "agent" },
          jump: e.proxyJump ? ids.get(e.proxyJump) ?? null : null,
          tmux: false,
          mcp: true,
          group: "ssh config",
          dir: null,
        };
        await api.hostSave(host);
      }
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="terminal-overlay">
      <div className="dialog settings">
        <h3>从 ~/.ssh/config 导入</h3>
        {entries === null && <p className="muted">正在读取…</p>}
        {entries?.length === 0 && <p className="muted">没有找到 ~/.ssh/config，或里面没有具体的主机配置</p>}
        <ul className="root-list import-list">
          {entries?.map((e) => (
            <li key={e.alias}>
              <label className="checkbox">
                <input type="checkbox" checked={picked.has(e.alias)} onChange={() => toggle(e.alias)} />
                <span>
                  <b>{e.alias}</b>{" "}
                  <span className="muted">
                    {e.user}@{e.hostName}
                    {e.port !== 22 && `:${e.port}`}
                    {e.identityFile && ` · ${e.identityFile}`}
                    {e.proxyJump && ` · 经 ${e.proxyJump}`}
                    {exists(e) && " · 已存在"}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="muted small">导入后归入「ssh config」分组；没写 IdentityFile 的主机使用 ssh-agent 登录，可之后在编辑里修改。</p>
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!picked.size} onClick={doImport}>
            导入 {picked.size} 台
          </button>
        </div>
      </div>
    </div>
  );
}
