import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "./modal";
import { NumberInput } from "./NumberInput";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, BUILTIN_NAME, defaultCloudName, errorText, Settings } from "./api";

type Patch = Partial<Pick<Settings, "roots" | "allowCommands" | "remotePort" | "device" | "builtinAlias">>;

/** 两块设置各自保存：保存前重读一次，只改自己管的字段，不会覆盖另一块刚保存的内容 */
async function savePatch(patch: Patch) {
  const cur = await api.settingsGet();
  return api.settingsSave({ roots: cur.roots, allowCommands: cur.allowCommands, remotePort: cur.remotePort, device: cur.device, builtinAlias: cur.builtinAlias, ...patch });
}

function useSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.settingsGet().then(setS).catch((e) => setError(errorText(e)));
  }, []);
  const patch = (p: Patch) => {
    setS((cur) => cur && { ...cur, ...p });
    setSaved(false);
  };
  const save = async (p: Patch, onSaved?: (s: Settings) => void) => {
    try {
      const next = await savePatch(p);
      setS(next);
      setSaved(true);
      setError("");
      onSaved?.(next);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return { s, setS, error, saved, patch, save };
}

function Footer({ error, saved, onSave }: { error: string; saved: boolean; onSave: () => void }) {
  return (
    <>
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        {saved && <span className="muted">已保存</span>}
        <button className="primary" onClick={onSave}>
          保存
        </button>
      </div>
    </>
  );
}

/** 内置工具的设置：云端名字和端口、云端能碰到哪些目录、能不能执行命令 */
export function BuiltinSettings({ onSaved }: { onSaved: (s: Settings) => void }) {
  const { s, error, saved, patch, save } = useSettings();
  if (!s) return null;
  const device = s.device.trim();

  const addRoot = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string" && !s.roots.includes(dir)) patch({ roots: [...s.roots, dir] });
  };

  return (
    <div className="host-form toolbox-detail">
      <div className="row">
        <label className="grow">
          云端名字：
          <input
            value={s.builtinAlias}
            onChange={(e) => patch({ builtinAlias: e.target.value })}
            placeholder={`默认 ${defaultCloudName(BUILTIN_NAME, device)}，可改成如 win-home`}
            spellCheck={false}
          />
          <span className="muted small">云端 Claude 里显示的名字，工具会叫 mcp__云端名字__工具名</span>
        </label>
        <label className="builtin-port">
          云端端口：
          <NumberInput min={1024} max={65535} value={s.remotePort} onChange={(remotePort) => patch({ remotePort })} />
          <span className="muted small">云主机 127.0.0.1 上的端口</span>
        </label>
      </div>
      <p className="muted">只有下面的目录会暴露给云端。写入、修改、删除前自动备份，每次操作都记入审计。</p>
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
        {s.roots.length === 0 && <li className="muted">还没有添加，云端目前访问不到任何文件</li>}
      </ul>
      <button onClick={addRoot}>添加目录…</button>

      <label className="checkbox" style={{ marginTop: 16 }}>
        <input type="checkbox" checked={s.allowCommands} onChange={(e) => patch({ allowCommands: e.target.checked })} />
        允许执行命令：云端可在本机用 cmd 运行命令（工作目录限定在上面的目录内）
      </label>
      <Footer
        error={error}
        saved={saved}
        onSave={() =>
          save({ roots: s.roots, allowCommands: s.allowCommands, builtinAlias: s.builtinAlias.trim(), remotePort: s.remotePort }, onSaved)
        }
      />
      <p className="muted small">改名字或端口后，对主机重新「配置 Claude」生效；旧名字的配置可在云端用 claude mcp remove 删掉。</p>
    </div>
  );
}

/** 这台电脑：标识和访问令牌。多台电脑连同一台主机时靠标识区分云端名字 */
export function DeviceSettings({ onSaved }: { onSaved: (s: Settings) => void }) {
  const { s, setS, error, saved, patch, save } = useSettings();
  if (!s) return null;
  const device = s.device.trim();

  const regen = async () => {
    const ok = await ask("更换令牌后，已配置的云端 Claude Code 需要重新「配置 Claude」。继续？", { title: "更换令牌", kind: "warning", okLabel: "更换" });
    if (!ok) return;
    setS(await api.settingsRegenToken());
  };

  return (
    <section className="page-card host-form device-card">
      <h3>这台电脑</h3>
      <p className="muted">
        家里和公司的电脑同时连同一台主机时：给每台电脑设不同的标识，云端名字就不会互相覆盖；
        各工具的云端端口也要错开（在上面工具列表里点「编辑」修改），否则后连上的那台建不了映射。
      </p>
      <div className="row">
        <label className="grow">
          标识：
          <input value={s.device} onChange={(e) => patch({ device: e.target.value })} placeholder="可选，如 home / office" spellCheck={false} />
          <span className="muted small">
            没自定义云端名字的工具会自动加上它，如 <code>{defaultCloudName("playwright", device)}</code>
          </span>
        </label>
      </div>
      <Footer error={error} saved={saved} onSave={() => save({ device }, onSaved)} />

      <div className="field-title">访问令牌：</div>
      <div className="row token-row">
        <code className="grow">
          {s.token.slice(0, 6)}…{s.token.slice(-4)}
        </code>
        <button onClick={() => writeText(s.token)}>复制</button>
        <button onClick={regen}>更换</button>
      </div>
      <p className="muted small">内置工具和本机命令类工具要求云端带上这个令牌，「配置 Claude」会自动写入；HTTP 类工具是直接端口转发，用它自己的鉴权。</p>
    </section>
  );
}
