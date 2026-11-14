import { useEffect, useState } from "react";
import { api, ClaudeMcpState, errorText, Host, hostTools, McpHostStatus, Settings } from "./api";
import { HostToolsTable, initRows, rowProblems, rowsToTools, ToolRow } from "./HostTools";
import { Loading } from "./Loading";
import { Combo } from "./Select";

export type McpStep = 1 | 2;

/** 用来判断第 1 步有没有未保存的修改 */
const toolsKey = (mcp: boolean, tools: unknown) => JSON.stringify({ mcp, tools });

/**
 * 主机的 MCP 配置：① 选工具（启用、云端名字、端口）→ ② 写入云端 Claude。
 * 两步放在同一个弹窗里，选完工具顺着「下一步」就写入，不用再去找「配置 Claude」。
 */
export function HostMcpDialog({
  host: initialHost,
  settings,
  status,
  initialStep,
  onHostSaved,
  onClose,
  onManage,
}: {
  host: Host;
  settings: Settings;
  status?: McpHostStatus;
  initialStep: McpStep;
  onHostSaved: (h: Host) => void;
  onClose: () => void;
  /** 去工具箱页添加或修改工具 */
  onManage: () => void;
}) {
  const [host, setHost] = useState(initialHost);
  const [step, setStep] = useState<McpStep>(initialStep);
  const [mcp, setMcp] = useState(initialHost.mcp);
  const [rows, setRows] = useState<ToolRow[]>(() => initRows(initialHost, settings));
  /** 每保存一次加一，第 2 步据此重新读取（保存会重建连接和端口映射） */
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const tools = rowsToTools(rows, settings);
  const dirty = toolsKey(mcp, mcp ? tools : null) !== toolsKey(host.mcp, host.mcp ? hostTools(host) : null);
  const invalid = mcp && rowProblems(rows, settings).size > 0;
  /** 保存后的状态是否能写入 Claude */
  const canWrite = mcp && tools.length > 0;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      // secret 传 undefined：不动已保存的密码/口令
      const saved = await api.hostSave({ ...host, mcp, tools });
      setHost(saved);
      setVersion((v) => v + 1);
      onHostSaved(saved);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** 去第 2 步：有未保存的修改先保存 */
  const toStep2 = async () => {
    if (invalid || !canWrite) return;
    if (dirty && !(await save())) return;
    setStep(2);
  };

  const stepButton = (n: McpStep, label: string, enabled: boolean, onClick: () => void) => (
    <button className={`mcp-step ${step === n ? "active" : ""}`} disabled={!enabled} aria-current={step === n ? "step" : undefined} onClick={onClick}>
      <span className="mcp-step-num">{n}</span>
      {label}
    </button>
  );

  return (
    <div className="terminal-overlay" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog host-form host-mcp-dialog">
        <h3>{host.name} · MCP 工具</h3>
        <nav className="mcp-steps" aria-label="步骤">
          {stepButton(1, "选择工具", true, () => setStep(1))}
          <span className="mcp-steps-line" />
          {stepButton(2, "写入 Claude", !invalid && canWrite && !saving, toStep2)}
        </nav>

        {step === 1 ? (
          <>
            <label className="checkbox">
              <input type="checkbox" checked={mcp} onChange={(e) => setMcp(e.target.checked)} />
              使用 MCP 工具箱：连接时为勾选的工具建立端口映射
            </label>
            {mcp && (
              <>
                <HostToolsTable rows={rows} onChange={setRows} settings={settings} status={status} />
                <p className="muted small">云端名字和端口只对这台主机生效，默认取工具箱里的设置。</p>
              </>
            )}
            {error && <p className="form-error">{error}</p>}
            <div className="dialog-actions">
              <button className="link" onClick={onManage}>
                管理工具箱…
              </button>
              <div className="grow" />
              <button onClick={onClose}>关闭</button>
              {dirty && (
                <button disabled={saving || invalid} onClick={save}>
                  仅保存
                </button>
              )}
              {canWrite ? (
                <button className="primary" disabled={saving || invalid} onClick={toStep2}>
                  {saving ? "保存中…" : dirty ? "保存，下一步：写入 Claude" : "下一步：写入 Claude"}
                </button>
              ) : (
                <button className="primary" disabled={saving || !dirty} onClick={async () => (await save()) && onClose()}>
                  保存
                </button>
              )}
            </div>
          </>
        ) : (
          <ClaudeStep key={version} host={host} onBack={() => setStep(1)} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

type Scope = "global" | "project";

interface Row {
  name: string;
  /** 云端的名字 */
  cloudName: string;
  /** 应配的地址；端口映射没建立时为 null */
  url: string | null;
  error: string | null;
  /** 当前作用域里已配的地址 */
  current?: string;
  /** 看项目时：全局是否已配好同一地址（已经能用） */
  globalOk: boolean;
  status: "error" | "ok" | "stale" | "missing";
}

function rowsOf(s: ClaudeMcpState, scope: Scope): Row[] {
  return s.wanted.map((w) => {
    const current = scope === "project" ? s.project[w.cloudName] : s.global[w.cloudName];
    const globalOk = scope === "project" && !!w.url && s.global[w.cloudName] === w.url;
    const status = !w.url ? "error" : current === w.url ? "ok" : current ? "stale" : "missing";
    return { ...w, current, globalOk, status };
  });
}

/** 默认勾选：没配的和地址不对的；全局已配好的项目里不重复配 */
const needsWrite = (r: Row) => r.status === "stale" || (r.status === "missing" && !r.globalOk);

const STATUS_TEXT: Record<Row["status"], string> = {
  ok: "已配置",
  stale: "已配置，但地址不同",
  missing: "未配置",
  error: "端口映射未建立",
};

/** 第 2 步：先读云端已有配置再决定写什么；可选全局或某个项目目录 */
function ClaudeStep({ host, onBack, onClose }: { host: Host; onBack: () => void; onClose: () => void }) {
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState(host.dir ?? "");
  const [st, setSt] = useState<ClaudeMcpState | null>(null);
  /** 上次读取时的作用域，和 st 配套 */
  const [loadedScope, setLoadedScope] = useState<Scope>("global");
  /** 云端 Claude 打开过的项目目录，第一次读到后一直保留；还没读到为 null */
  const [projects, setProjects] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = async (sc: Scope, d: string) => {
    setLoading(true);
    setError("");
    try {
      const s = await api.claudeMcpState(host.id, sc === "project" ? d.trim() : null);
      setSt(s);
      setLoadedScope(sc);
      setProjects(s.projects);
      if (s.dir) setDir(s.dir);
      setChecked(new Set(rowsOf(s, sc).filter(needsWrite).map((r) => r.name)));
    } catch (e) {
      setError(errorText(e));
      setSt(null);
      setProjects((p) => p ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load("global", "");
  }, []);

  const switchScope = (sc: Scope) => {
    setScope(sc);
    setDone("");
    if (sc === "global") load("global", "");
    else if (dir.trim()) load("project", dir);
    else setSt(null);
  };

  const apply = async (add: string[], remove: string[]) => {
    setBusy(true);
    setError("");
    try {
      await api.claudeMcpApply(host.id, loadedScope === "project" ? st?.dir ?? null : null, add, remove);
      const cloud = (names: string[]) => names.map((n) => st?.wanted.find((w) => w.name === n)?.cloudName ?? n).join("、");
      const parts = [add.length && `已写入 ${cloud(add)}`, remove.length && `已移除 ${cloud(remove)}`].filter(Boolean);
      setDone(`${parts.join("，")}。新开的对话或新启动的 claude 生效。`);
      await load(loadedScope, st?.dir ?? "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rows = st && scope === loadedScope ? rowsOf(st, scope) : [];
  const toWrite = rows.filter((r) => r.url && checked.has(r.name)).map((r) => r.name);
  const allOk = rows.length > 0 && rows.every((r) => r.status === "ok" || r.globalOk);
  const dirOptions = [...new Set([host.dir, ...(projects ?? [])].filter((d): d is string => !!d))].map((d) => ({ value: d }));

  const toggle = (name: string, on: boolean) =>
    setChecked((s) => {
      const next = new Set(s);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  return (
    <>
      <p className="muted">把上一步勾选的工具写进云端 Claude Code 的 MCP 配置。你在云端自己加的其他 MCP 不受影响。</p>

      <div className="seg" role="radiogroup">
        <button role="radio" aria-checked={scope === "global"} className={scope === "global" ? "active" : ""} onClick={() => switchScope("global")}>
          全局
          <span className="muted small">这台主机上任何目录启动的 Claude 都能用</span>
        </button>
        <button role="radio" aria-checked={scope === "project"} className={scope === "project" ? "active" : ""} onClick={() => switchScope("project")}>
          指定项目
          <span className="muted small">只在该目录下启动的 Claude 能用</span>
        </button>
      </div>

      {scope === "project" && (
        <div className="row claude-setup-dir">
          <Combo
            value={dir}
            onChange={setDir}
            options={dirOptions}
            placeholder="云主机上的项目目录，如 ~/work/app"
            className="grow"
            loading={projects === null ? "正在连接主机、读取 Claude 打开过的项目…" : undefined}
          />
          <button disabled={!dir.trim() || loading} onClick={() => load("project", dir)}>
            {loading && scope === "project" ? (
              <>
                <span className="spinner" aria-hidden="true" /> 读取中
              </>
            ) : (
              "读取"
            )}
          </button>
        </div>
      )}

      {loading && <Loading text="正在连接主机并读取云端配置，首次连接可能需要几秒" />}
      {!loading && scope === "project" && !(st && loadedScope === "project") && !error && (
        <p className="muted">选择或输入项目目录后点「读取」。</p>
      )}

      {!loading && rows.length > 0 && (
        <div className="claude-setup-list">
          {rows.map((r) => (
            <div key={r.name} className={`claude-setup-row ${r.status}`}>
              <label className="checkbox">
                <input type="checkbox" disabled={!r.url} checked={checked.has(r.name)} onChange={(e) => toggle(r.name, e.target.checked)} />
                <span className="mcp-name">{r.cloudName}</span>
              </label>
              <div className="grow claude-setup-info">
                <span className={`claude-setup-status ${r.status}`}>
                  {STATUS_TEXT[r.status]}
                  {r.globalOk && r.status === "missing" && "（全局已配好，这里可不配）"}
                </span>
                <code className="muted">{r.url ?? r.error}</code>
                {r.status === "stale" && <code className="muted">现在是：{r.current}</code>}
              </div>
              {r.current && (
                <button className="link" disabled={busy} onClick={() => apply([], [r.name])}>
                  移除
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {done && <p className="ok-text">{done}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <button onClick={onBack}>← 上一步</button>
        <div className="grow" />
        <button onClick={onClose}>{allOk ? "完成" : "关闭"}</button>
        {!allOk && (
          <button className="primary" disabled={busy || loading || toWrite.length === 0} onClick={() => apply(toWrite, [])}>
            {busy ? "写入中…" : `写入 ${toWrite.length} 项`}
          </button>
        )}
      </div>
    </>
  );
}
