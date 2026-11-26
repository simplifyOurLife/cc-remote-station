import { useEffect, useState } from "react";
import { api, BUILTIN_NAME, ClaudeMcpState, COMMAND_MODES, CommandMode, commandModeLabel, errorText, Host, hostTools, McpHostStatus, Settings, toolLabel } from "./api";
import { HostToolsTable, initRows, rowProblems, rowsToTools, ToolRow } from "./HostTools";
import { Loading } from "./Loading";
import { Combo, Select } from "./Select";
import { getFlag, MCP_REGISTERED, MCP_TIP_HIDDEN, setFlag } from "./onboarding";

/** fwd：端口转发；reg：Claude 注册 */
export type McpTab = "fwd" | "reg";

/** 用来判断转发页有没有未保存的修改 */
const toolsKey = (mcp: boolean, tools: unknown) => JSON.stringify({ mcp, tools });

/**
 * 主机的 MCP 弹窗，两个平级的标签页：
 * ① 端口转发：哪些工具转到这台主机、用哪个端口，连接时自动建立；
 * ② Claude 注册：把已转发的工具登记到云端 ~/.claude.json（全局或某个项目），名字在注册时决定。
 */
export function HostMcpDialog({
  host: initialHost,
  settings,
  status,
  initialTab,
  onHostSaved,
  onClose,
  onManage,
}: {
  host: Host;
  settings: Settings;
  status?: McpHostStatus;
  initialTab: McpTab;
  onHostSaved: (h: Host) => void;
  onClose: () => void;
  /** 去工具箱页添加或修改工具 */
  onManage: () => void;
}) {
  const [host, setHost] = useState(initialHost);
  const [tab, setTab] = useState<McpTab>(initialTab);
  const [mcp, setMcp] = useState(initialHost.mcp);
  const [rows, setRows] = useState<ToolRow[]>(() => initRows(initialHost, settings));
  /** 这台主机单独的命令管控模式；null 跟随全局 */
  const [cmdMode, setCmdMode] = useState<CommandMode | null>(initialHost.commandMode ?? null);
  /** 打开应用就建立端口映射 */
  const [autostart, setAutostart] = useState(!!initialHost.mcpAutostart);
  /** 每保存一次加一，注册页据此重新读取（保存会重建连接和转发） */
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** 顶部的两步说明：关掉一次就不再显示 */
  const [tip, setTip] = useState(() => getFlag(MCP_TIP_HIDDEN) !== "1");

  const tools = rowsToTools(rows, settings);
  const dirty =
    toolsKey(mcp, mcp ? tools : null) !== toolsKey(host.mcp, host.mcp ? hostTools(host) : null) ||
    cmdMode !== (host.commandMode ?? null) ||
    autostart !== !!host.mcpAutostart;
  const invalid = mcp && rowProblems(rows).size > 0;
  const savedTools = host.mcp ? hostTools(host) : [];
  /** 已保存的设置里没转发的工具，注册页显示为灰色 */
  const unforwarded = initRows(host, settings)
    .map((r) => r.name)
    .filter((n) => !savedTools.some((t) => t.name === n));

  const persist = async (nextMcp: boolean, nextRows: ToolRow[]) => {
    setSaving(true);
    setError("");
    try {
      // secret 传 undefined：不动已保存的密码/口令
      const saved = await api.hostSave({ ...host, mcp: nextMcp, tools: rowsToTools(nextRows, settings), commandMode: cmdMode, mcpAutostart: autostart });
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

  /** 切到注册页：转发页有未保存的修改先保存，注册页看到的就是实际生效的转发 */
  const toReg = async () => {
    if (tab === "reg") return;
    if (dirty) {
      if (invalid) return setError("先改好端口问题，或放弃修改");
      if (!(await persist(mcp, rows))) return;
    }
    setTab("reg");
  };

  /** 注册页上的「开启转发」：勾上这一项并立即保存 */
  const forward = async (name: string) => {
    const next = rows.map((r) => (r.name === name ? { ...r, on: true } : r));
    setRows(next);
    setMcp(true);
    await persist(true, next);
  };

  const tabButton = (t: McpTab, n: number, label: string, hint: string, onClick: () => void) => (
    <button role="tab" className={`mcp-step ${tab === t ? "active" : ""}`} aria-selected={tab === t} disabled={saving} title={hint} onClick={onClick}>
      <span className="mcp-step-num">{n}</span>
      {label}
    </button>
  );

  return (
    <div className="terminal-overlay" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog host-form host-mcp-dialog">
        <h3>{host.name} · MCP</h3>
        <nav className="mcp-steps" role="tablist">
          {tabButton("fwd", 1, "端口转发", "云主机 127.0.0.1:端口 → 本机工具，连接主机时自动建立", () => setTab("fwd"))}
          {tabButton("reg", 2, "Claude 注册", "把已转发的工具写进云端 ~/.claude.json，新开的 claude 才能用", toReg)}
        </nav>
        {tip && (
          <div className="mcp-tip">
            <span>
              两步生效：① <b>端口转发</b>让云主机能连到本机工具（连接主机时自动建立）；② <b>Claude 注册</b>把它登记到云端 Claude，之后新开的对话才能用。
            </span>
            <button
              className="icon"
              title="知道了，不再显示"
              onClick={() => {
                setFlag(MCP_TIP_HIDDEN);
                setTip(false);
              }}
            >
              ×
            </button>
          </div>
        )}

        {tab === "fwd" ? (
          <>
            <p className="muted small mcp-tab-lead">
              为勾选的工具建立转发：云主机 127.0.0.1:端口 → 本机目标，端口默认取工具箱里的默认映射端口。能免密登录的主机单独开一条连接专门转发，和终端、对话互不影响。
            </p>
            <label className="checkbox">
              <input type="checkbox" checked={mcp} onChange={(e) => setMcp(e.target.checked)} />
              连接时转发 MCP 工具
            </label>
            {mcp && (
              <div className="row host-command-mode">
                <span>建立端口映射：</span>
                <Select
                  value={autostart ? "launch" : "connect"}
                  onChange={(v) => setAutostart(v === "launch")}
                  options={[
                    { value: "connect", label: "第一次连这台主机时", hint: "打开它的终端或对话时建立，之后一直保持，断了自动重连" },
                    { value: "launch", label: "打开 cc-remote-station 时", hint: "应用一启动就建立，不用先开终端；登录要验证码的主机仍要等终端连上后借用它的连接" },
                  ]}
                />
              </div>
            )}
            {mcp && <HostToolsTable rows={rows} onChange={setRows} settings={settings} status={status} />}
            {mcp && rows.some((r) => r.name === BUILTIN_NAME && r.on) && (
              <div className="row host-command-mode">
                <span>这台主机执行本机命令：</span>
                <Select
                  value={cmdMode ?? ""}
                  onChange={(v) => setCmdMode(v ? (v as CommandMode) : null)}
                  options={[
                    { value: "", label: `跟随全局（${commandModeLabel(settings.commandMode)}）` },
                    ...COMMAND_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint })),
                  ]}
                />
              </div>
            )}
            {error && <p className="form-error">{error}</p>}
            <div className="dialog-actions">
              <button className="link" onClick={onManage}>
                管理工具箱…
              </button>
              <div className="grow" />
              {dirty && (
                <button
                  disabled={saving}
                  onClick={() => {
                    setMcp(host.mcp);
                    setRows(initRows(host, settings));
                    setCmdMode(host.commandMode ?? null);
                    setAutostart(!!host.mcpAutostart);
                    setError("");
                  }}
                >
                  放弃修改
                </button>
              )}
              <button onClick={onClose}>关闭</button>
              <button className="primary" disabled={saving || invalid || !dirty} onClick={() => persist(mcp, rows)}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </>
        ) : (
          <RegisterTab key={version} host={host} unforwarded={unforwarded} busy={saving} onForward={forward} onClose={onClose} />
        )}
        {tab === "reg" && error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}

type Scope = "global" | "project";
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;

interface Row {
  name: string;
  /** 应配的地址；转发没建立时为 null */
  url: string | null;
  error: string | null;
  /** 当前作用域里指向这个地址的名字（按地址认，云端改过名也认得出） */
  registered: string | null;
  /** 看项目时：全局里已注册的名字（已经能用） */
  globalName: string | null;
}

const findByUrl = (m: Record<string, string>, url: string | null) => (url && Object.keys(m).find((k) => m[k] === url)) || null;

function rowsOf(s: ClaudeMcpState, scope: Scope): Row[] {
  const map = scope === "project" ? s.project : s.global;
  return s.wanted.map((w) => ({
    name: w.name,
    url: w.url,
    error: w.error,
    registered: findByUrl(map, w.url),
    globalName: scope === "project" ? findByUrl(s.global, w.url) : null,
  }));
}

/** 注册页：先读云端已有配置，再逐项注册 / 移除；可选全局或某个项目目录 */
function RegisterTab({
  host,
  unforwarded,
  busy: saving,
  onForward,
  onClose,
}: {
  host: Host;
  unforwarded: string[];
  busy: boolean;
  onForward: (name: string) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>("global");
  const [dir, setDir] = useState(host.dir ?? "");
  const [st, setSt] = useState<ClaudeMcpState | null>(null);
  /** 上次读取时的作用域，和 st 配套 */
  const [loadedScope, setLoadedScope] = useState<Scope>("global");
  /** 云端 Claude 打开过的项目目录，第一次读到后一直保留；还没读到为 null */
  const [projects, setProjects] = useState<string[] | null>(null);
  /** 各工具要注册成的名字：已注册的用云端现在的名字，否则取工具箱里的默认映射名称 */
  const [names, setNames] = useState<Record<string, string>>({});
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
      const rows = rowsOf(s, sc);
      setNames((prev) =>
        Object.fromEntries(s.wanted.map((w) => [w.name, rows.find((r) => r.name === w.name)?.registered ?? prev[w.name] ?? w.defaultName])),
      );
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

  const rows = st && scope === loadedScope ? rowsOf(st, scope) : [];
  const map = st ? (loadedScope === "project" ? st.project : st.global) : {};
  /** 名字的问题：不合法，或和别的行重名 */
  const nameProblem = (r: Row) => {
    const n = (names[r.name] ?? "").trim();
    if (!NAME_RE.test(n)) return "名字只能用英文字母、数字、- 和 _";
    if (rows.some((o) => o !== r && (o.registered ?? names[o.name]?.trim()) === n)) return `名字 ${n} 重复`;
    return null;
  };
  /** 名字已被别的 MCP 占用（指向别的地址），注册会覆盖它 */
  const clash = (r: Row) => {
    const n = (names[r.name] ?? "").trim();
    return !r.registered && map[n] && map[n] !== r.url ? map[n] : null;
  };
  const canRegister = (r: Row) => !!r.url && !r.registered && !nameProblem(r);
  const pending = rows.filter((r) => canRegister(r) && !r.globalName);

  const apply = async (add: Row[], remove: string[]) => {
    setBusy(true);
    setError("");
    try {
      const reg = add.map((r) => ({ name: r.name, cloudName: names[r.name].trim() }));
      await api.claudeMcpApply(host.id, loadedScope === "project" ? st?.dir ?? null : null, reg, remove);
      if (reg.length) setFlag(MCP_REGISTERED);
      const where = loadedScope === "project" ? st?.dir : "全局";
      const parts = [reg.length && `已把 ${reg.map((r) => r.cloudName).join("、")} 注册到${where}`, remove.length && `已移除 ${remove.join("、")}`].filter(Boolean);
      setDone(`${parts.join("，")}。新开的对话或新启动的 claude 生效。`);
      await load(loadedScope, st?.dir ?? "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const dirOptions = [...new Set([host.dir, ...(projects ?? [])].filter((d): d is string => !!d))].map((d) => ({ value: d }));
  const locked = busy || saving || loading;

  return (
    <>
      <p className="muted small mcp-tab-lead">
        把已转发的工具登记到云端 Claude Code。按地址识别是否已注册，云端改过名字也认得出；你在云端自己加的其他 MCP 不受影响。
      </p>

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

      {!loading && (rows.length > 0 || (st && unforwarded.length > 0)) && (
        <div className="host-tools-table-wrap">
          <table className="host-tools-table register-table">
            <thead>
              <tr>
                <th>工具</th>
                <th>在 Claude 里的名字</th>
                <th>地址</th>
                <th className="col-state">状态</th>
                <th className="col-act" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const problem = !r.registered && r.url ? nameProblem(r) : null;
                const taken = clash(r);
                return (
                  <tr key={r.name} className={problem ? "bad" : ""}>
                    <td>
                      <span className="mcp-name">{toolLabel(r.name)}</span>
                      {problem && <div className="form-error small">{problem}</div>}
                      {!problem && taken && <div className="warn-text small">这个名字现在指向 {taken}，注册会覆盖它</div>}
                    </td>
                    <td>
                      <input
                        value={names[r.name] ?? ""}
                        disabled={!!r.registered || !r.url}
                        title={r.registered ? "已注册；要改名先移除再注册" : undefined}
                        onChange={(e) => setNames((n) => ({ ...n, [r.name]: e.target.value }))}
                        spellCheck={false}
                      />
                    </td>
                    <td>
                      <code className="muted" title={r.url ?? r.error ?? ""}>
                        {r.url ? r.url.replace(/^http:\/\/127\.0\.0\.1/, "") : "—"}
                      </code>
                    </td>
                    <td className="col-state">
                      {!r.url ? (
                        <span className="form-error inline" title={r.error ?? ""}>
                          转发失败
                        </span>
                      ) : r.registered ? (
                        <span className="ok-text">✓ 已注册</span>
                      ) : r.globalName ? (
                        <span className="ok-text" title={`全局里叫 ${r.globalName}`}>
                          全局已有
                        </span>
                      ) : (
                        <span className="muted">未注册</span>
                      )}
                    </td>
                    <td className="col-act">
                      {r.registered ? (
                        <button disabled={locked} onClick={() => apply([], [r.registered!])}>
                          移除
                        </button>
                      ) : (
                        r.url && (
                          <button className={r.globalName ? "" : "primary"} disabled={locked || !canRegister(r)} onClick={() => apply([r], [])}>
                            {r.globalName ? "仍然注册" : "注册"}
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
              {st &&
                unforwarded.map((name) => (
                  <tr key={name} className="off">
                    <td>
                      <span className="mcp-name">{toolLabel(name)}</span>
                    </td>
                    <td colSpan={2} className="muted small">
                      没有转发到这台主机，注册了也连不上
                    </td>
                    <td className="col-state">
                      <span className="muted">未转发</span>
                    </td>
                    <td className="col-act">
                      <button disabled={locked} onClick={() => onForward(name)}>
                        开启转发
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {done && <p className="ok-text">{done}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="dialog-actions">
        <div className="grow" />
        <button onClick={onClose}>关闭</button>
        <button className="primary" disabled={locked || pending.length === 0} onClick={() => apply(pending, [])}>
          {busy ? "处理中…" : pending.length ? `全部注册（${pending.length}）` : "都已注册"}
        </button>
      </div>
    </>
  );
}
