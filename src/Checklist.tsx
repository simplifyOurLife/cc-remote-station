import { useState } from "react";
import { api, errorText, Host, HostCheck } from "./api";
import { copyText } from "./copy";
import { ENV_OK, GUIDE_HIDDEN, setFlag, Step } from "./onboarding";
import { Select } from "./Select";

const INSTALL_CMD = "curl -fsSL https://claude.ai/install.sh | bash";
const TMUX_CMD = "sudo apt install -y tmux";

/** 启动台顶部的上手清单：必做三步展开，可选两步折叠；必做都完成后收成一行 */
export function Checklist({
  steps,
  done,
  total,
  hosts,
  onAddHost,
  onImport,
  onTerminal,
  onToolbox,
}: {
  steps: Step[];
  done: number;
  total: number;
  hosts: Host[];
  onAddHost: () => void;
  onImport: () => void;
  onTerminal: (h: Host) => void;
  onToolbox: () => void;
}) {
  const finished = done === total;
  const [open, setOpen] = useState(!finished);
  const [showOptional, setShowOptional] = useState(false);
  const required = steps.filter((s) => !s.optional);
  const optional = steps.filter((s) => s.optional);
  // 第一个没完成的必做步骤高亮
  const current = required.find((s) => !s.done)?.key;

  const action = (s: Step) => {
    if (s.done) return null;
    switch (s.key) {
      case "host":
        return (
          <div className="row">
            <button onClick={onImport}>从 ssh config 导入</button>
            <button className="primary" onClick={onAddHost}>
              添加主机
            </button>
          </div>
        );
      case "open":
        return hosts.length > 0 ? <span className="muted small">在下方主机卡片上点「对话」</span> : null;
      case "files":
      case "cmd":
        return <button onClick={onToolbox}>去设置</button>;
      default:
        return null;
    }
  };

  const row = (s: Step, n: number) => (
    <li key={s.key} className={`${s.done ? "done" : ""} ${s.key === current ? "current" : ""}`}>
      <span className="checklist-mark">{s.done ? "✓" : n}</span>
      <div className="grow">
        <div className="checklist-title">{s.title}</div>
        {!s.done && <div className="muted small">{s.hint}</div>}
        {s.key === "env" && !s.done && hosts.length > 0 && <EnvCheck hosts={hosts} onTerminal={onTerminal} />}
      </div>
      {action(s)}
    </li>
  );

  return (
    <section className="checklist">
      <div className="checklist-head">
        <span className="checklist-heading">{finished ? "✓ 上手完成" : "上手清单"}</span>
        <span className="checklist-progress">
          <span style={{ width: `${(done / total) * 100}%` }} />
        </span>
        <span className="muted small">
          {done}/{total}
        </span>
        <div className="grow" />
        {finished && (
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "收起" : "展开"}
          </button>
        )}
        <button className="link" onClick={() => setFlag(GUIDE_HIDDEN)}>
          不再显示
        </button>
      </div>
      {open && (
        <>
          <ol className="checklist-steps">{required.map((s, i) => row(s, i + 1))}</ol>
          <button className="link checklist-more" onClick={() => setShowOptional(!showOptional)}>
            {showOptional ? "▾" : "▸"} 可选：把本机能力交给云端 Claude（{optional.filter((s) => s.done).length}/{optional.length}）
          </button>
          {showOptional && <ol className="checklist-steps">{optional.map((s, i) => row(s, required.length + i + 1))}</ol>}
        </>
      )}
    </section>
  );
}

/** 环境检查：选一台主机，查 claude / 登录 / tmux，缺什么就给出命令 */
function EnvCheck({ hosts, onTerminal }: { hosts: Host[]; onTerminal: (h: Host) => void }) {
  const [hostId, setHostId] = useState(hosts[0].id);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HostCheck | null>(null);
  const [error, setError] = useState("");
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0];

  const run = async () => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const r = await api.hostCheck(host.id);
      setResult(r);
      if (r.claude && r.loggedIn && (r.tmux || !host.tmux)) setFlag(ENV_OK, host.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const fix = (cmd: string) => (
    <span className="env-fix">
      <code>{cmd}</code>
      <button className="link" onClick={() => copyText(cmd, "命令")}>
        复制
      </button>
      <button className="link" onClick={() => onTerminal(host)}>
        打开终端
      </button>
    </span>
  );

  return (
    <div className="env-check">
      <div className="row env-check-bar">
        {hosts.length > 1 && (
          <Select value={hostId} onChange={(v) => setHostId(v)} options={hosts.map((h) => ({ value: h.id, label: h.name, hint: h.host }))} />
        )}
        <button className="primary env-check-btn" disabled={busy} onClick={run}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? "检查中" : "开始检查"}
        </button>
        {hosts.length === 1 && <span className="muted small">检查 {host.name}</span>}
      </div>
      {error && <p className="form-error">{error}</p>}
      {result && (
        <ul className="env-result">
          <li className={result.claude ? "ok" : "bad"}>
            {result.claude ? `✓ Claude Code ${result.claude}` : "✕ 没找到 claude 命令，在云主机上安装："}
            {!result.claude && fix(INSTALL_CMD)}
          </li>
          {result.claude && (
            <li className={result.loggedIn ? "ok" : "bad"}>
              {result.loggedIn ? "✓ 已登录" : "✕ 没检测到登录信息：在终端里运行 claude，按提示登录（或配置 ANTHROPIC_API_KEY）"}
              {!result.loggedIn && fix("claude")}
            </li>
          )}
          <li className={result.tmux ? "ok" : host.tmux ? "bad" : "muted"}>
            {result.tmux
              ? "✓ tmux 已安装"
              : host.tmux
                ? "✕ 这台主机开了「保持会话」但没装 tmux（CentOS 用 yum）："
                : "– 没装 tmux：只影响「保持会话」，可以不装"}
            {!result.tmux && host.tmux && fix(TMUX_CMD)}
          </li>
        </ul>
      )}
    </div>
  );
}
