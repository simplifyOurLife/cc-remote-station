/**
 * CLI 原生命令的图形版：/usage、/context、/model（含 /effort）、/status、/output-style、/agents、/config。
 * 除 /config 外数据都来自控制请求，打开面板不消耗 token
 */
import { ReactNode, useEffect, useState } from "react";
import { api, ClaudeConfig, errorText, PermissionMode } from "./api";
import { Select } from "./Select";
import { Loading } from "./Loading";
import { RefreshButton } from "./RefreshButton";
import { ChatState, McpServer, ModelOption, NativeInfo } from "./chatModel";
import { hostShortTime, HostTz, tzLabel } from "./hostTime";
import { MODES } from "./ChatStatus";
import { copyText } from "./copy";

/** 设置结果的一行提示：CLI 成功时说 "Set …"，值不对时也是正常退出、只回一句说明 */
type Note = { text: string; ok: boolean } | null;
const noteOf = (text: string): Note => ({ text, ok: /^Set /m.test(text) });

const k = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const isoSec = (s: string | null | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return isNaN(t) ? null : t / 1000;
};

/** onRefresh 返回 Promise 就等它；数据靠控制请求回执推回来的传 data，等它从 null 变回来 */
function Panel(p: {
  title: ReactNode;
  className: string;
  onClose: () => void;
  onRefresh?: () => unknown;
  data?: Record<string, any> | null;
  children: ReactNode;
}) {
  const [round, setRound] = useState(0);
  return (
    <div
      className="pane-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}
      onKeyDown={(e) => e.key === "Escape" && p.onClose()}
    >
      <div className={`dialog native-panel ${p.className}`} tabIndex={-1} ref={(el) => el?.focus()}>
        <div className="native-head">
          <h3>{p.title}</h3>
          <div className="grow" />
          {p.onRefresh && (
            <RefreshButton
              className="link"
              onClick={p.onRefresh}
              busy={p.data === undefined ? undefined : p.data === null}
              result={() => !p.data?.error && undefined}
              onDone={() => setRound((n) => n + 1)}
            />
          )}
        </div>
        <div key={round} className={round ? "refreshed" : undefined}>
          {p.children}
        </div>
        <div className="dialog-actions">
          <button onClick={p.onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 一条横向用量条：label · 条 · 数值 */
function Meter({ label, pct, value, note, tone }: { label: ReactNode; pct: number; value: string; note?: ReactNode; tone?: string }) {
  const cls = tone ?? (pct >= 90 ? "bad" : pct >= 70 ? "warn" : "ok");
  return (
    <div className={`meter ${cls}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="meter-value">{value}</span>
      {note && <span className="meter-note muted">{note}</span>}
    </div>
  );
}

function Failed({ data, what }: { data: Record<string, any> | null; what: string }) {
  if (!data) return <Loading text={`正在读取${what}`} />;
  return <p className="form-error">读取{what}失败：{data.error}（云端 Claude Code 版本较旧时不支持，可在终端里执行对应命令）</p>;
}

// ---------------- /usage ----------------

const LIMIT_KINDS: Record<string, string> = {
  session: "5 小时窗口",
  weekly_all: "本周 · 全部模型",
  weekly_opus: "本周 · Opus",
  weekly_sonnet: "本周 · Sonnet",
};

function Behaviors({ title, b, onSend, onOpenMcp }: { title: string; b: any; onSend: (t: string) => void; onOpenMcp: () => void }) {
  if (!b) return null;
  const tops: [string, any[]][] = [
    ["MCP 服务器", b.mcp_servers],
    ["技能", b.skills],
    ["子代理", b.agents],
    ["插件", b.plugins],
  ];
  const fix = b.fix?.messages?.[0];
  return (
    <div className="usage-behaviors">
      <div className="field-title">
        {title} <span className="muted">· {b.request_count ?? 0} 次请求 · {b.session_count ?? 0} 个会话</span>
      </div>
      {(b.recommendations ?? []).map((r: any) => (
        <div key={r.key + r.title} className="usage-rec">
          <b>{r.pct}%</b>
          <span>
            {r.title}
            {r.detail && <span className="muted"> · {r.detail}</span>}
          </span>
          {r.key === "mcp_server" && (
            <button className="link" onClick={onOpenMcp}>
              管理 MCP
            </button>
          )}
        </div>
      ))}
      {!b.recommendations?.length && <p className="muted small-text">没有需要注意的地方。</p>}
      {tops
        .filter(([, list]) => list?.length)
        .map(([name, list]) => (
          <div key={name} className="muted small-text usage-top">
            {name}占比：{list.map((x: any) => `${x.name} ${x.pct}%`).join("，")}
          </div>
        ))}
      {fix && (
        <button className="usage-fix" title={fix} onClick={() => onSend(fix)}>
          让 Claude 按建议处理（会发一条消息）
        </button>
      )}
    </div>
  );
}

export function UsagePanel(p: {
  data: NativeInfo["usage"];
  tz: HostTz | null;
  onRefresh: () => void;
  onSend: (text: string) => void;
  onOpenMcp: () => void;
  onClose: () => void;
}) {
  const d = p.data;
  const ok = d && !d.error;
  const rl = ok ? d.rate_limits : null;
  const limits: any[] = rl?.limits ?? [];
  const session = ok ? d.session : null;
  const spend = rl?.spend;
  const breakdown: any[] = rl?.seven_day_breakdown?.rows ?? [];
  return (
    <Panel
      title={
        <>
          用量 {ok && d.subscription_type && <span className="muted">{String(d.subscription_type).toUpperCase()} 订阅</span>}
        </>
      }
      className="usage-panel"
      onRefresh={p.onRefresh}
      data={d}
      onClose={p.onClose}
    >
      {!ok && <Failed data={d} what="用量" />}
      {ok && (
        <>
          {d.rate_limits_available === false && <p className="muted">当前用 API key 按量计费，没有订阅额度，看下面的花费即可。</p>}
          {limits.length > 0 && (
            <div className="meters">
              {limits.map((l) => {
                const at = isoSec(l.resets_at);
                return (
                  <Meter
                    key={l.kind}
                    label={LIMIT_KINDS[l.kind] ?? l.kind}
                    pct={l.percent ?? 0}
                    value={`${l.percent ?? 0}%`}
                    tone={l.severity && l.severity !== "normal" ? "warn" : undefined}
                    note={at ? `${hostShortTime(at, p.tz)} 重置` : undefined}
                  />
                );
              })}
            </div>
          )}
          {spend?.enabled && (
            <div className="meters">
              <Meter
                label="额外用量"
                pct={spend.percent ?? 0}
                value={`${(spend.used?.amount_minor ?? 0) / 10 ** (spend.used?.exponent ?? 2)} ${spend.used?.currency ?? ""}`}
                note={spend.limit ? `上限 ${spend.limit.amount_minor / 10 ** (spend.limit.exponent ?? 2)}` : undefined}
              />
            </div>
          )}
          {breakdown.some((r) => r.percent > 0) && (
            <>
              <div className="field-title">本周用量构成</div>
              <div className="meters">
                {breakdown
                  .filter((r) => r.percent > 0)
                  .map((r) => (
                    <Meter key={r.key} label={r.display_name} pct={r.percent} value={`${r.percent}%`} tone="ok" note={`占额度 ${r.percent_of_limit}%`} />
                  ))}
              </div>
            </>
          )}
          {session && (
            <div className="muted small-text usage-session">
              本会话：花费约 ${(session.total_cost_usd ?? 0).toFixed(2)}（按 API 价格估算）· API 耗时 {Math.round((session.total_api_duration_ms ?? 0) / 1000)} 秒 · 代码 +
              {session.total_lines_added ?? 0} / -{session.total_lines_removed ?? 0} 行
            </div>
          )}
          <Behaviors title="近 24 小时" b={d.behaviors?.day} onSend={p.onSend} onOpenMcp={p.onOpenMcp} />
          <Behaviors title="近 7 天" b={d.behaviors?.week} onSend={p.onSend} onOpenMcp={p.onOpenMcp} />
          <p className="muted small-text">用量构成是近似值，只统计这台云主机上的会话，各项可能重叠。时间按{tzLabel(p.tz)}。</p>
        </>
      )}
    </Panel>
  );
}

// ---------------- /context ----------------

const CATEGORY_COLORS: Record<string, string> = {
  system_prompt: "#8a84b8",
  system_tools: "#6c63c7",
  mcp_tools: "var(--cyan)",
  mcp_instructions: "var(--mint)",
  memory_files: "#b388ff",
  custom_agents: "#ff8a4d",
  skills: "var(--amber)",
  messages: "var(--magenta)",
};
const CATEGORY_NAMES: Record<string, string> = {
  system_prompt: "系统提示",
  system_tools: "内置工具",
  system_tools_deferred: "内置工具（延迟加载）",
  mcp_tools: "MCP 工具",
  mcp_tools_deferred: "MCP 工具（延迟加载）",
  mcp_instructions: "MCP 服务器说明",
  memory_files: "记忆文件（CLAUDE.md）",
  custom_agents: "自定义子代理",
  skills: "技能",
  messages: "对话消息",
  autocompact_buffer: "自动压缩预留",
  free_space: "剩余空间",
};
const catColor = (c: any) => CATEGORY_COLORS[c.id] ?? "var(--dim)";

/** 一组「名称 · tokens」明细，按 tokens 倒序，默认只列前 8 个 */
function TokenList({ title, rows }: { title: string; rows: { name: string; tokens: number; note?: string }[] }) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  return (
    <details className="ctx-list">
      <summary>
        {title} <span className="muted">· {rows.length} 项 · {k(rows.reduce((a, r) => a + r.tokens, 0))}</span>
      </summary>
      {sorted.map((r) => (
        <div key={r.name} className="ctx-list-row">
          <span className="grow" title={r.name}>
            {r.name}
            {r.note && <span className="muted"> · {r.note}</span>}
          </span>
          <span className="muted">{k(r.tokens)}</span>
        </div>
      ))}
    </details>
  );
}

export function ContextPanel(p: { data: NativeInfo["context"]; running: boolean; onRefresh: () => void; onCompact: () => void; onClose: () => void }) {
  const d = p.data;
  const ok = d && !d.error;
  const max: number = ok ? d.maxTokens || 1 : 1;
  const cats: any[] = ok ? d.categories ?? [] : [];
  const inBar = cats.filter((c) => c.kind === "used" && c.tokens > 0);
  const buffer = cats.find((c) => c.kind === "buffer");
  const mb = ok ? d.messageBreakdown : null;
  const named = (list: any[] | undefined) =>
    (list ?? []).filter((x) => typeof x?.tokens === "number").map((x) => ({ name: String(x.name ?? x.path ?? "?"), tokens: x.tokens, note: x.serverName ?? x.source ?? x.type }));
  return (
    <Panel
      title={
        <>
          上下文 {ok && <span className="muted">{d.model}</span>}
        </>
      }
      className="context-panel"
      onRefresh={p.onRefresh}
      data={d}
      onClose={p.onClose}
    >
      {!ok && <Failed data={d} what="上下文" />}
      {ok && (
        <>
          <div className="ctx-total">
            <b>{k(d.totalTokens ?? 0)}</b> / {k(max)} tokens <span className="muted">（{d.percentage ?? 0}%）</span>
          </div>
          <div className="ctx-bar">
            {inBar.map((c) => (
              <i key={c.id} title={`${CATEGORY_NAMES[c.id] ?? c.name}：${c.tokens.toLocaleString()}`} style={{ width: `${(c.tokens / max) * 100}%`, background: catColor(c) }} />
            ))}
            <span className="grow" />
            {buffer && <i className="ctx-buffer" title={`自动压缩预留：${buffer.tokens.toLocaleString()}`} style={{ width: `${(buffer.tokens / max) * 100}%` }} />}
          </div>
          <div className="ctx-cats">
            {cats.map((c) => (
              <div key={c.id} className={`ctx-cat ${c.kind}`}>
                <i style={{ background: c.kind === "used" ? catColor(c) : undefined }} />
                <span className="grow">{CATEGORY_NAMES[c.id] ?? c.name}</span>
                <span>{k(c.tokens)}</span>
                <span className="muted ctx-pct">{((c.tokens / max) * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
          <p className="muted small-text">
            「延迟加载」的工具只占名字，用到时才把完整定义拉进上下文，不计入已用。
            {d.isAutoCompactEnabled ? `用到约 ${k(d.autoCompactThreshold ?? 0)} 时自动压缩。` : "自动压缩已关闭。"}
          </p>
          {mb && (mb.toolCallTokens || mb.toolResultTokens || mb.userMessageTokens || mb.assistantMessageTokens) ? (
            <TokenList
              title="对话消息明细"
              rows={[
                { name: "工具调用", tokens: mb.toolCallTokens ?? 0 },
                { name: "工具结果", tokens: mb.toolResultTokens ?? 0 },
                { name: "附件", tokens: mb.attachmentTokens ?? 0 },
                { name: "Claude 回复", tokens: mb.assistantMessageTokens ?? 0 },
                { name: "你的消息", tokens: mb.userMessageTokens ?? 0 },
                ...(mb.toolCallsByType ?? [])
                  .filter((t: any) => t?.name)
                  .map((t: any) => ({ name: `  ${t.name}`, tokens: (t.callTokens ?? 0) + (t.resultTokens ?? 0), note: "调用 + 结果" })),
              ].filter((r) => r.tokens > 0)}
            />
          ) : null}
          <TokenList title="记忆文件" rows={named(d.memoryFiles)} />
          <TokenList title="MCP 工具" rows={named(d.mcpTools)} />
          <TokenList title="子代理" rows={named(d.agents)} />
          <TokenList title="技能" rows={named(d.skills?.skillFrontmatter)} />
          <div className="native-actions">
            <button disabled={p.running || !(d.totalTokens > 0)} onClick={p.onCompact} title="总结之前的对话，释放上下文（会消耗一次额度）">
              /compact 压缩
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

// ---------------- /model + /effort ----------------

const EFFORT_NAMES: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

export function ModelPanel(p: {
  models: ModelOption[];
  /** 本窗格选的模型，空为默认 */
  model: string;
  applied: NativeInfo["applied"];
  onModel: (m: string) => void;
  onEffort: (e: string) => void;
  onClose: () => void;
}) {
  const cur = p.model || "default";
  const sel = p.models.find((m) => m.value === cur) ?? p.models.find((m) => m.value === "default");
  return (
    <Panel
      title={
        <>
          模型 {p.applied?.model && <span className="muted">当前生效：{p.applied.model}</span>}
        </>
      }
      className="model-panel"
      onClose={p.onClose}
    >
      {!p.models.length && <Loading text="正在从云端 Claude 读取可选模型" />}
      <div className="picker-list">
        {p.models.map((m) => (
          <div key={m.value} className={`menu-item ${m.value === cur ? "selected" : ""}`} onClick={() => p.onModel(m.value === "default" ? "" : m.value)}>
            <span className="model-name">{m.label}</span>
            <code className="muted">{m.value}</code>
            {m.description && <span className="muted menu-hint">{m.description}</span>}
          </div>
        ))}
      </div>
      {sel?.efforts?.length ? (
        <>
          <div className="field-title">
            思考强度 <span className="muted">· 越高越仔细、越耗额度（只对当前对话生效，同 /effort）</span>
          </div>
          <div className="effort-row">
            {sel.efforts.map((e) => (
              <button key={e} className={p.applied?.effort === e ? "primary" : ""} onClick={() => p.onEffort(e)}>
                {EFFORT_NAMES[e] ?? e} <span className="muted">{e}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

// ---------------- /status ----------------

export function StatusPanel(p: { state: ChatState; cwd: string; mode: PermissionMode; mcpServers: McpServer[]; onClose: () => void }) {
  const n = p.state.native;
  const a = n.account;
  const rows: [string, ReactNode][] = [
    ["Claude Code", n.version ? `v${n.version}` : "—"],
    ["账号", a?.email ?? "—"],
    ["组织", a?.organization ?? "—"],
    ["订阅 / 计费", [a?.subscriptionType, a?.apiProvider && a.apiProvider !== "firstParty" ? a.apiProvider : null].filter(Boolean).join(" · ") || "—"],
    ["模型", n.applied?.model ?? p.state.model ?? "默认"],
    ["思考强度", n.applied?.effort ? `${EFFORT_NAMES[n.applied.effort] ?? n.applied.effort}（${n.applied.effort}）` : "—"],
    ["权限模式", MODES.find((m) => m.value === p.mode)?.label ?? p.mode],
    ["输出风格", n.outputStyle ?? "—"],
    ["工作目录", <code>{p.cwd}</code>],
    [
      "会话 ID",
      p.state.sessionId ? (
        <span className="status-copy" title="点击复制" onClick={() => copyText(p.state.sessionId!)}>
          <code>{p.state.sessionId}</code>
        </span>
      ) : (
        "新会话（发消息后生成）"
      ),
    ],
    ["MCP", p.mcpServers.length ? `${p.mcpServers.filter((m) => m.status === "connected").length}/${p.mcpServers.length} 已连接` : "无"],
  ];
  return (
    <Panel title="状态" className="status-panel" onClose={p.onClose}>
      <dl className="status-grid">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

// ---------------- /output-style ----------------

const STYLE_HINTS: Record<string, string> = {
  default: "默认：专注完成编码任务",
  Proactive: "主动：顺手多做一步，减少来回确认",
  Concise: "简洁：回复更短",
  Explanatory: "讲解：边做边解释实现思路和取舍",
  Learning: "学习：讲解之外，留一些代码让你自己动手写",
};

export function OutputStylePanel(p: {
  hostId: string;
  cwd: string;
  styles: string[];
  current: string | null;
  onPick: (style: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState<Note>(null);
  const [saving, setSaving] = useState(false);
  const cur = p.current ?? "default";
  const saveDefault = () => {
    setSaving(true);
    api
      .claudeConfigSet(p.hostId, p.cwd, "outputStyle", cur)
      .then((t) => setNote(noteOf(t)))
      .catch((e) => setNote({ text: errorText(e), ok: false }))
      .finally(() => setSaving(false));
  };
  return (
    <Panel title="输出风格" className="style-panel" onClose={p.onClose}>
      {!p.styles.length && <Loading text="正在从云端 Claude 读取输出风格" />}
      <div className="picker-list">
        {p.styles.map((s) => (
          <div key={s} className={`menu-item ${s === cur ? "selected" : ""}`} onClick={() => s !== cur && p.onPick(s)}>
            <span className="model-name">{s}</span>
            <span className="muted menu-hint">{STYLE_HINTS[s] ?? "自定义风格"}</span>
          </div>
        ))}
      </div>
      <p className="muted small-text">
        这里切换只对当前对话生效。输出风格是系统提示的一部分，切换后下一条消息的缓存会失效、按完整上下文重新计费，长对话里慎切。
        自定义风格放在云主机的 ~/.claude/output-styles/ 下。
      </p>
      <div className="native-actions">
        <button disabled={saving || !p.styles.length} onClick={saveDefault} title={`写入 ${p.cwd}/.claude/settings.local.json`}>
          {saving ? "保存中…" : `设为这个目录的默认（${cur}）`}
        </button>
        {note && <span className={note.ok ? "muted" : "form-error"}>{note.text}</span>}
      </div>
    </Panel>
  );
}

// ---------------- /agents ----------------

export function AgentsPanel(p: { agents: NativeInfo["agents"]; onDraft: (text: string) => void; onClose: () => void }) {
  return (
    <Panel
      title={
        <>
          子代理 {p.agents.length > 0 && <span className="muted">{p.agents.length} 个</span>}
        </>
      }
      className="agents-panel"
      onClose={p.onClose}
    >
      {!p.agents.length && <Loading text="正在从云端 Claude 读取子代理" />}
      <div className="mcp-list">
        {p.agents.map((a) => (
          <div key={a.name} className="mcp-row">
            <div className="mcp-row-head">
              <span className="mcp-state ok" />
              <span className="mcp-name">{a.name}</span>
              {a.model && <span className="muted mcp-meta">模型 {a.model === "inherit" ? "跟随对话" : a.model}</span>}
              <div className="grow" />
              <button className="link" onClick={() => p.onDraft(`用 ${a.name} 子代理：`)}>
                使用
              </button>
            </div>
            {a.description && (
              <div className="muted agent-desc" title={a.description}>
                {a.description}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="muted small-text">
        子代理定义在云主机的 ~/.claude/agents/（全局）或项目的 .claude/agents/ 下，新建或修改后新开对话生效。新建、修改都可以直接让 Claude 来做。
      </p>
      <div className="native-actions">
        <button onClick={() => p.onDraft("/agents 新建一个子代理，用途：")}>让 Claude 新建子代理</button>
      </div>
    </Panel>
  );
}

// ---------------- /config ----------------

/** /config 的键 → 配置文件里的字段（实测 CLI 2.1.329）；没列的同名 */
const CONFIG_FIELDS: Record<string, string> = {
  autoCompact: "autoCompactEnabled",
  autoScroll: "autoScrollEnabled",
  checkpoints: "fileCheckpointingEnabled",
  editor: "editorMode",
  gitignore: "respectGitignore",
  notifChannel: "preferredNotifChannel",
  permissionMode: "permissions.defaultMode",
  prStatus: "prStatusFooterEnabled",
  progressBar: "terminalProgressBarEnabled",
  recap: "awaySummaryEnabled",
  reduceMotion: "prefersReducedMotion",
  remoteControl: "remoteControlAtStartup",
  tips: "spinnerTipsEnabled",
  turnDuration: "showTurnDuration",
  worktreeBaseRef: "worktree.baseRef",
};

const CONFIG_LABELS: Record<string, string> = {
  model: "默认模型",
  outputStyle: "输出风格（写到当前目录）",
  permissionMode: "默认权限模式",
  autoCompact: "上下文快满时自动压缩",
  idleCompaction: "闲置后自动压缩",
  thinking: "扩展思考",
  language: "回复语言",
  checkpoints: "文件检查点（可回退修改）",
  gitignore: "搜索文件时遵守 .gitignore",
  recap: "离开后回来时给出会话回顾",
  promptSuggestionEnabled: "输入建议",
  switchModelsOnFlag: "消息被拦截时切换模型",
  useAutoModeDuringPlan: "计划模式下使用自动模式",
  workflows: "工作流",
  workflowKeywordTriggerEnabled: "关键词触发工作流",
  workflowSizeGuideline: "工作流规模",
  worktreeBaseRef: "新建 worktree 的基准",
  remoteControl: "启动时开启远程控制",
  verbose: "详细输出",
  agentPushNotifEnabled: "代理推送通知",
  inputNeededNotifEnabled: "需要输入时通知",
  notifChannel: "通知方式",
  theme: "主题",
  editor: "输入框编辑模式",
  autoScroll: "自动滚动",
  autoConnectIde: "自动连接 IDE",
  copyFullResponse: "复制完整回复",
  copyOnSelect: "选中即复制",
  defaultToAgentsView: "默认打开代理视图",
  externalEditorContext: "外部编辑器带上下文",
  leftArrowOpensAgents: "← 键打开代理视图",
  prStatus: "底部显示 PR 状态",
  progressBar: "终端进度条",
  reduceMotion: "减少动画",
  timeFormat: "时间格式",
  tips: "加载时显示提示",
  turnDuration: "显示每轮耗时",
};

/** 影响 Claude 本身行为的项（对话界面也生效）；其余主要影响终端里的 claude 界面 */
const BEHAVIOR_KEYS = new Set([
  "model",
  "outputStyle",
  "permissionMode",
  "autoCompact",
  "idleCompaction",
  "thinking",
  "language",
  "checkpoints",
  "gitignore",
  "switchModelsOnFlag",
  "useAutoModeDuringPlan",
  "workflows",
  "workflowKeywordTriggerEnabled",
  "workflowSizeGuideline",
  "worktreeBaseRef",
  "verbose",
]);

interface ConfigItem {
  key: string;
  /** 可选值；null 为任意文字 */
  options: string[] | null;
}

/** 解析 `/config` 的用法说明：每行 "  key=a|b|c" 或 "  key=<value>" */
function parseConfigUsage(usage: string): ConfigItem[] {
  return usage
    .split("\n")
    .map((l) => /^\s+(\w+)=(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ key: m[1], options: m[2].trim().startsWith("<") ? null : m[2].trim().split("|") }));
}

/** 当前值：项目本地 > 项目 > 用户 > ~/.claude.json；都没有为 null（默认） */
function configValue(cfg: ClaudeConfig, key: string): string | null {
  const path = (CONFIG_FIELDS[key] ?? key).split(".");
  for (const src of [cfg.local, cfg.project, cfg.user, cfg.global]) {
    const v = path.reduce<any>((o, k) => o?.[k], src);
    if (v === undefined || v === null) continue;
    if (key === "switchModelsOnFlag" && typeof v === "boolean") return v ? "Switch automatically" : "Ask each time";
    return String(v);
  }
  return null;
}

function ConfigRow(p: { item: ConfigItem; value: string | null; busy: boolean; note: Note; onSet: (v: string) => void }) {
  const { item, value } = p;
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const bool = item.options?.length === 2 && item.options.includes("true") && item.options.includes("false");
  return (
    <div className="config-row">
      <span className="config-label" title={item.key}>
        {CONFIG_LABELS[item.key] ?? item.key}
        <code className="muted">{item.key}</code>
      </span>
      <span className="config-control">
        {bool ? (
          <span className="effort-row">
            {["true", "false"].map((v) => (
              <button key={v} disabled={p.busy} className={value === v ? "primary" : ""} onClick={() => value !== v && p.onSet(v)}>
                {v === "true" ? "开" : "关"}
              </button>
            ))}
            {value === null && <span className="muted small-text">默认</span>}
          </span>
        ) : item.options ? (
          <Select
            value={value ?? ""}
            options={[...(value === null ? [{ value: "", label: "（默认）" }] : []), ...item.options.map((o) => ({ value: o }))]}
            onChange={(v) => v && v !== value && p.onSet(v)}
          />
        ) : (
          <span className="effort-row">
            <input value={text} placeholder="（默认）" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && p.onSet(text.trim())} />
            <button disabled={p.busy || !text.trim() || text.trim() === value} onClick={() => p.onSet(text.trim())}>
              保存
            </button>
          </span>
        )}
      </span>
      {(p.busy || p.note) && (
        <span className={`config-note ${p.note && !p.note.ok ? "form-error" : "muted"}`}>{p.busy ? "保存中…" : p.note!.text}</span>
      )}
    </div>
  );
}

export function ConfigPanel(p: { hostId: string; cwd: string; onClose: () => void }) {
  const [cfg, setCfg] = useState<ClaudeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [filter, setFilter] = useState("");
  const load = () => {
    setError(null);
    return api
      .claudeConfigRead(p.hostId, p.cwd)
      .then((c) => {
        setCfg(c);
        return true;
      })
      .catch((e) => {
        setError(errorText(e));
        return false as const;
      });
  };
  useEffect(() => {
    load();
  }, []);
  const set = (key: string, value: string) => {
    setBusy(key);
    api
      .claudeConfigSet(p.hostId, p.cwd, key, value)
      .then((t) => {
        setNotes((n) => ({ ...n, [key]: noteOf(t) }));
        return load();
      })
      .catch((e) => setNotes((n) => ({ ...n, [key]: { text: errorText(e), ok: false } })))
      .finally(() => setBusy(null));
  };
  const q = filter.trim().toLowerCase();
  const items = cfg ? parseConfigUsage(cfg.usage).filter((i) => !q || i.key.toLowerCase().includes(q) || (CONFIG_LABELS[i.key] ?? "").includes(q)) : [];
  const row = (i: ConfigItem) => (
    <ConfigRow key={i.key} item={i} value={configValue(cfg!, i.key)} busy={busy === i.key} note={notes[i.key] ?? null} onSet={(v) => set(i.key, v)} />
  );
  const behavior = items.filter((i) => BEHAVIOR_KEYS.has(i.key));
  const terminal = items.filter((i) => !BEHAVIOR_KEYS.has(i.key));
  return (
    <Panel title="Claude Code 设置" className="config-panel" onRefresh={() => (setCfg(null), load().then((ok) => ok && undefined))} onClose={p.onClose}>
      <p className="muted small-text">
        写入云主机的 Claude Code 设置（~/.claude/settings.json 等，输出风格写到当前目录），之后新开的对话和终端里的 claude 都生效。
        当前对话的模型、权限模式、输出风格请用对应的面板或输入框上方的切换。
      </p>
      {error && <p className="form-error">读取设置失败：{error}</p>}
      {!cfg && !error && <Loading text="正在读取云主机上的 Claude Code 设置" />}
      {cfg && (
        <>
          <input className="config-filter" value={filter} placeholder="过滤设置项" onChange={(e) => setFilter(e.target.value)} />
          {!items.length && <p className="muted">没有匹配的设置项{cfg.usage && !parseConfigUsage(cfg.usage).length ? `（CLI 输出无法识别：${cfg.usage.slice(0, 200)}）` : ""}</p>}
          <div className="config-list">
            {behavior.length > 0 && <div className="field-title">Claude 行为</div>}
            {behavior.map(row)}
            {terminal.length > 0 && (
              <details open={!!q}>
                <summary className="field-title">终端界面 <span className="muted">· 主要影响在终端里用 claude</span></summary>
                {terminal.map(row)}
              </details>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
