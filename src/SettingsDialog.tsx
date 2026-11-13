import { useEffect, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, errorText, Settings } from "./api";

/** 本机访问设置：云端 Claude Code 经 MCP 能碰到哪些目录、能不能执行命令 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settingsGet().then(setS).catch((e) => setError(errorText(e)));
  }, []);
  if (!s) return null;

  const patch = (p: Partial<Settings>) => {
    setS({ ...s, ...p });
    setSaved(false);
  };

  const addRoot = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string" && !s.roots.includes(dir)) patch({ roots: [...s.roots, dir] });
  };

  const save = async () => {
    try {
      setS(await api.settingsSave({ roots: s.roots, allowCommands: s.allowCommands, remotePort: s.remotePort }));
      setSaved(true);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };

  const regen = async () => {
    const ok = await ask("更换令牌后，已配置的云端 Claude Code 需要重新「配置 Claude」。继续？", { title: "更换令牌", kind: "warning" });
    if (!ok) return;
    setS(await api.settingsRegenToken());
  };

  return (
    <div className="terminal-overlay">
      <div className="dialog host-form settings">
        <h3>本机访问设置</h3>
        <p className="muted">
          开启「允许访问本机」的主机连接后，云端 Claude Code 可以通过 SSH 隧道操作下面的目录。写入前自动备份，所有操作记入审计日志。
        </p>

        <div className="field-title">允许访问的目录：</div>
        <ul className="root-list">
          {s.roots.map((r) => (
            <li key={r}>
              <code>{r}</code>
              <button className="icon" title="移除" onClick={() => patch({ roots: s.roots.filter((x) => x !== r) })}>
                ×
              </button>
            </li>
          ))}
          {s.roots.length === 0 && <li className="muted">尚未添加，云端将无法访问任何文件</li>}
        </ul>
        <button onClick={addRoot}>添加目录…</button>

        <label className="checkbox" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={s.allowCommands} onChange={(e) => patch({ allowCommands: e.target.checked })} />
          允许执行命令：云端可在本机用 cmd 运行命令（工作目录限定在上面的目录内）
        </label>

        <label>
          云端转发端口：
          <input
            type="number"
            min={1024}
            max={65535}
            value={s.remotePort}
            onChange={(e) => patch({ remotePort: Number(e.target.value) })}
          />
        </label>
        <p className="muted small">云主机上监听 127.0.0.1:{s.remotePort}，修改后需重新连接主机并重新「配置 Claude」。</p>

        <div className="field-title">访问令牌：</div>
        <div className="row token-row">
          <code className="grow">{s.token.slice(0, 6)}…{s.token.slice(-4)}</code>
          <button onClick={() => writeText(s.token)}>复制</button>
          <button onClick={regen}>更换</button>
        </div>

        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          {saved && <span className="muted">已保存</span>}
          <button onClick={onClose}>关闭</button>
          <button className="primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
