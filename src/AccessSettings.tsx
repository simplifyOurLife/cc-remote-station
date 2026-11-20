import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ask } from "./modal";
import { NumberInput } from "./NumberInput";
import { SaveButton } from "./SaveButton";
import { copyText } from "./copy";
import { api, BUILTIN_NAME, COMMAND_MODES, CommandMode, commandModeLabel, defaultCloudName, errorText, Settings, SettingsField } from "./api";

type Patch = Partial<Pick<Settings, SettingsField>>;

/** 两块设置各自保存：保存前重读一次，只改自己管的字段，不会覆盖另一块刚保存的内容 */
async function savePatch(patch: Patch) {
  const cur = await api.settingsGet();
  return api.settingsSave({
    roots: cur.roots,
    commandMode: cur.commandMode,
    commandAllowlist: cur.commandAllowlist,
    remotePort: cur.remotePort,
    device: cur.device,
    builtinAlias: cur.builtinAlias,
    ...patch,
  });
}

function useSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.settingsGet().then(setS).catch((e) => setError(errorText(e)));
  }, []);
  const patch = (p: Patch) => {
    setS((cur) => cur && { ...cur, ...p });
  };
  const save = async (p: Patch, onSaved?: (s: Settings) => void) => {
    try {
      const next = await savePatch(p);
      setS(next);
      setError("");
      onSaved?.(next);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  return { s, setS, error, patch, save };
}

/** 命令执行的管控：全局模式 + 白名单（主机可在「MCP 转发」里单独设模式） */
function CommandControl({
  mode,
  allowlist,
  onMode,
  onAllowlist,
}: {
  mode: CommandMode;
  allowlist: string[];
  onMode: (m: CommandMode) => void;
  onAllowlist: (rules: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const rule = draft.trim().split(/\s+/).join(" ");
    if (rule && !allowlist.includes(rule)) onAllowlist([...allowlist, rule]);
    setDraft("");
  };
  return (
    <section className="builtin-pane command-control">
      <p className="muted small">
        管 run_command / command_output / stop_command。命令不受目录限制，能做当前用户能做的任何事。这里是默认模式，主机可在「MCP 转发」里单独设。
      </p>
      <div className="seg command-modes" role="radiogroup">
        {COMMAND_MODES.map((m) => (
          <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} className={mode === m.value ? "active" : ""} onClick={() => onMode(m.value)}>
            {m.label}
            <span className="muted small">{m.hint}</span>
          </button>
        ))}
      </div>
      <div className="field-title">白名单 <span className="muted small">「白名单 + 确认」模式下直接执行</span></div>
      <ul className="root-list">
        {allowlist.map((r) => (
          <li key={r}>
            <code>{r}</code>
            <button className="icon" title="移除" onClick={() => onAllowlist(allowlist.filter((x) => x !== r))}>
              ×
            </button>
          </li>
        ))}
        {allowlist.length === 0 && <li className="muted">空：所有命令都要确认，可在确认弹窗里点「总是允许」加入</li>}
      </ul>
      <div className="row command-rule-add">
        <input
          className="grow"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="如 git 或 npm run build"
          spellCheck={false}
        />
        <button type="button" disabled={!draft.trim()} onClick={add}>
          添加
        </button>
      </div>
      <p className="muted small">
        按词匹配开头：git 放行全部 git 命令，git status 只放这一种；带 &amp; | &gt; 等拼接符或带路径的命令总要确认。
        <br />
        npm、mvn、node、python 会运行项目里的脚本，加进白名单等于允许运行项目代码。
      </p>
    </section>
  );
}

function Footer({ error, onSave }: { error: string; onSave: () => Promise<boolean> }) {
  return (
    <>
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <SaveButton onSave={onSave} />
      </div>
    </>
  );
}

/** 内置工具的设置，分三个标签：默认映射、文件访问、命令执行；一个保存按钮一起保存 */
type BuiltinTab = "map" | "files" | "cmd";

export function BuiltinSettings({ onSaved }: { onSaved: (s: Settings) => void }) {
  const { s, error, patch, save } = useSettings();
  const [tab, setTab] = useState<BuiltinTab>("map");
  if (!s) return null;
  const device = s.device.trim();

  const addRoot = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string" && !s.roots.includes(dir)) patch({ roots: [...s.roots, dir] });
  };

  const tabs: { key: BuiltinTab; label: string; meta: string }[] = [
    { key: "map", label: "默认映射", meta: `${s.builtinAlias.trim() || defaultCloudName(BUILTIN_NAME, device)} :${s.remotePort}` },
    { key: "files", label: "文件访问", meta: s.roots.length ? `${s.roots.length} 个目录` : "未添加" },
    { key: "cmd", label: "命令执行", meta: commandModeLabel(s.commandMode) },
  ];

  return (
    <div className="host-form toolbox-detail builtin-settings">
      <div className="segmented builtin-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
            {t.label}
            <span className="builtin-tab-meta">{t.meta}</span>
          </button>
        ))}
      </div>

      {tab === "map" && (
        <section className="builtin-pane">
          <p className="muted small">每台主机默认这样映射：端口用于端口转发，名称用于注册到 Claude（工具名 mcp__名称__…）。</p>
          <div className="row builtin-map-row">
            <label className="default-map-port">
              默认映射端口
              <NumberInput min={1024} max={65535} value={s.remotePort} onChange={(remotePort) => patch({ remotePort })} />
            </label>
            <label className="grow">
              默认映射名称
              <input
                value={s.builtinAlias}
                onChange={(e) => patch({ builtinAlias: e.target.value })}
                placeholder={`${defaultCloudName(BUILTIN_NAME, device)}，可改成如 win-home`}
                spellCheck={false}
              />
            </label>
          </div>
          <p className="muted small">改端口后，在主机的「Claude 注册」里重新注册一次；改名称只影响以后的注册。</p>
        </section>
      )}

      {tab === "files" && (
        <section className="builtin-pane">
          <p className="muted small">只有这些目录会暴露给云端；写入、修改、删除前自动备份，每次操作记入审计。</p>
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
        </section>
      )}

      {tab === "cmd" && (
        <CommandControl
          mode={s.commandMode}
          allowlist={s.commandAllowlist}
          onMode={(commandMode) => patch({ commandMode })}
          onAllowlist={(commandAllowlist) => patch({ commandAllowlist })}
        />
      )}
      <Footer
        error={error}
        onSave={() =>
          save(
            {
              roots: s.roots,
              commandMode: s.commandMode,
              commandAllowlist: s.commandAllowlist,
              builtinAlias: s.builtinAlias.trim(),
              remotePort: s.remotePort,
            },
            onSaved,
          )
        }
      />
    </div>
  );
}

/** 这台电脑：标识和访问令牌。多台电脑连同一台主机时靠标识区分云端名字 */
export function DeviceSettings({ onSaved }: { onSaved: (s: Settings) => void }) {
  const { s, setS, error, patch, save } = useSettings();
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
      <Footer error={error} onSave={() => save({ device }, onSaved)} />

      <div className="field-title">访问令牌：</div>
      <div className="row token-row">
        <code className="grow">
          {s.token.slice(0, 6)}…{s.token.slice(-4)}
        </code>
        <button onClick={() => copyText(s.token, "访问令牌")}>复制</button>
        <button onClick={regen}>更换</button>
      </div>
      <p className="muted small">内置工具和本机命令类工具要求云端带上这个令牌，「配置 Claude」会自动写入；HTTP 类工具是直接端口转发，用它自己的鉴权。</p>
    </section>
  );
}
