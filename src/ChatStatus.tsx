import { useEffect, useRef, useState } from "react";
import { PermissionMode } from "./api";
import { RateLimit, Usage } from "./chatModel";
import { hostShortTime, HostTz, tzLabel } from "./hostTime";
import { PopupMenu } from "./PopupMenu";
import { hotCompactPct, pctText } from "./quota";

export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: "default", label: "逐条审批", hint: "改文件、跑命令前都问你" },
  { value: "acceptEdits", label: "自动接受编辑", hint: "改文件不再询问，跑命令仍要审批" },
  { value: "plan", label: "计划模式", hint: "只读分析并给出计划，批准后才动手" },
  { value: "bypassPermissions", label: "跳过所有权限", hint: "什么都不问直接执行，慎用" },
];

/** Shift+Tab 在前三种之间轮换（和 CLI 一样）；跳过所有权限只能从菜单选，免得误切 */
export function nextMode(m: PermissionMode): PermissionMode {
  const cycle: PermissionMode[] = ["default", "acceptEdits", "plan"];
  return cycle[(cycle.indexOf(m) + 1) % cycle.length];
}

const WINDOWS: Record<string, string> = {
  five_hour: "5 小时窗口",
  seven_day: "7 天窗口",
  seven_day_opus: "7 天 Opus",
  seven_day_sonnet: "7 天 Sonnet",
};

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** 距重置还有多久：44m / 4h44m / 4天14h */
function left(sec: number): string {
  const m = Math.max(1, Math.ceil(sec / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}天${h % 24 ? `${h % 24}h` : ""}`;
}

interface ChipView {
  cls: string;
  /** 芯片底色填充比例 0–100 */
  fill: number;
  value: string;
  /** 重置倒计时，没有就不显示 */
  reset: string | null;
  /** 悬浮详情里的一行 */
  line: string | null;
}

/** 已用比例分四档：绿 ok → 黄 mid → 橙 warn → 红 crit（用尽另有闪烁的 bad）；steps 是进入后三档的阈值 */
const QUOTA_STEPS: [number, number, number] = [50, 80, 95];
const CTX_STEPS: [number, number, number] = [50, 70, 85];
function level(pct: number, [mid, warn, crit]: [number, number, number]): string {
  return pct >= crit ? "crit" : pct >= warn ? "warn" : pct >= mid ? "mid" : "ok";
}

/** 一个额度窗口的芯片：已用比例、重置倒计时、悬浮详情里的一行 */
function windowView(r: RateLimit | undefined, now: number, tz: HostTz | null): ChipView {
  if (!r) return { cls: "idle", fill: 0, value: "—", reset: null, line: null };
  const name = WINDOWS[r.window] ?? r.window;
  const remain = r.resetsAt ? r.resetsAt - now : null;
  const at = r.resetsAt ? hostShortTime(r.resetsAt, tz) : "";
  // 已过重置时间：新窗口还没开始计，就是 0%
  if (remain !== null && remain <= 0) return { cls: "ok", fill: 0, value: "0%", reset: null, line: `${name}：${at} 已重置，下次回复后刷新` };
  const reset = remain !== null ? left(remain) : null;
  if (r.status === "rejected") return { cls: "bad", fill: 100, value: "用尽", reset, line: `${name}：已用尽${at ? `，${at} 恢复` : ""}` };
  const pct = r.usedPct;
  const lv = level(pct ?? 0, QUOTA_STEPS);
  return {
    // CLI 报「接近上限」时至少按橙色
    cls: r.status === "allowed_warning" && (lv === "ok" || lv === "mid") ? "warn" : lv,
    fill: pct ?? 0,
    value: pct !== null ? `${pct}%` : "—",
    reset,
    line: `${name}：${pct !== null ? `已用 ${pct}%` : "用量未报告"}${r.status === "allowed_warning" ? "（接近上限）" : ""}${at ? `，${at} 重置` : ""}`,
  };
}

/** 切角芯片：底色按比例从左填充，重置倒计时跟在后面 */
function Chip({ label, v, title, onClick }: { label: string; v: ChipView; title?: string; onClick?: () => void }) {
  return (
    <span
      className={`q-chip ${v.cls}${onClick ? " clickable" : ""}`}
      style={{ "--fill": `${Math.min(100, Math.max(0, v.fill))}%` } as React.CSSProperties}
      title={title}
      onClick={onClick}
    >
      <b>{label}</b>
      <span className="q-val">{v.value}</span>
      {v.reset && <span className="q-reset">⟳ {v.reset}</span>}
    </span>
  );
}

/** 输入框上方的状态栏：权限模式（可切换），再是和 CLI 状态栏一样的一行：5h · 7d · ctx · 花费 */
export function ChatStatus({
  mode,
  onMode,
  usage,
  rateLimits,
  tz,
  baseContext,
  onOpen,
  onHotCompact,
  model,
}: {
  /** 估算额度用的模型（各模型价格不同） */
  model: string | null;
  mode: PermissionMode;
  onMode: (m: PermissionMode) => void;
  usage: Usage;
  rateLimits: Record<string, RateLimit>;
  /** 云主机时区：重置时间按 Claude 运行的地方显示 */
  tz: HostTz | null;
  /** 新会话还没回复时用来预估上下文（这台主机上次新会话首轮的大小） */
  baseContext: number | null;
  /** 点额度芯片打开 /usage 面板，点 CTX 打开 /context 面板 */
  onOpen: (panel: "usage" | "context") => void;
  /** 上下文很大且缓存还在时给出：点了发 /compact */
  onHotCompact?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // 重置倒计时每分钟走一次，不用等下次回复
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => clearInterval(t);
  }, []);

  const cur = MODES.find((m) => m.value === mode) ?? MODES[0];
  const used = usage.contextUsed;
  const pct = used !== null && usage.contextWindow ? Math.min(100, Math.round((used / usage.contextWindow) * 100)) : null;
  // 上下文：有实际值用实际值；新会话用上次首轮大小预估（暗色）；都没有就是空槽
  const estPct = used === null && baseContext && usage.contextWindow ? Math.round((baseContext / usage.contextWindow) * 100) : null;
  const ctx: ChipView =
    used !== null
      ? { cls: pct === null ? "ok" : level(pct, CTX_STEPS), fill: pct ?? 0, value: pct !== null ? `${pct}%` : kTokens(used), reset: null, line: null }
      : estPct !== null
        ? { cls: "idle est", fill: estPct, value: `~${estPct}%`, reset: null, line: null }
        : { cls: "idle", fill: 0, value: "—", reset: null, line: null };

  const h5 = windowView(rateLimits.five_hour, now, tz);
  const d7 = windowView(rateLimits.seven_day, now, tz);
  const list = Object.values(rateLimits);
  const quotaTitle = list.length
    ? [
        ...list.map((r) => windowView(r, now, tz).line),
        `数据更新于 ${hostShortTime(Math.max(...list.map((r) => r.updatedAt)) / 1000, tz)}（启动对话和每次回复后刷新）`,
        `时间按${tzLabel(tz)}`,
      ].join("\n")
    : "云端 Claude 启动后读取 5 小时 / 7 天窗口的用量。\n用 API key 按量计费时没有额度，看花费即可。";

  return (
    <div className="chat-status">
      <button
        ref={anchor}
        className={`mode-chip mode-${mode}`}
        title={`${cur.hint}\n点击切换，或在输入框里按 Shift+Tab 轮换`}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        <span className="mode-glyph">⏵⏵</span>
        {cur.label}
        <kbd>⇧Tab</kbd>
      </button>
      {menu && (
        <PopupMenu anchor={anchor} onClose={() => setMenu(false)}>
          {MODES.map((m) => (
            <div key={m.value} className={`menu-item ${m.value === mode ? "selected" : ""}`} onClick={() => onMode(m.value)}>
              <span className={`mode-dot mode-${m.value}`}>{m.label}</span>
              <span className="muted menu-hint">{m.hint}</span>
            </div>
          ))}
        </PopupMenu>
      )}

      <span className="status-line">
        <Chip label="5H" v={h5} title={`${quotaTitle}\n点击查看详细用量（/usage）`} onClick={() => onOpen("usage")} />
        <Chip label="7D" v={d7} title={`${quotaTitle}\n点击查看详细用量（/usage）`} onClick={() => onOpen("usage")} />
        <Chip
          label="CTX"
          v={ctx}
          onClick={() => onOpen("context")}
          title={`${
            used !== null
              ? `上下文已用 ${used.toLocaleString()} tokens${usage.contextWindow ? ` / 窗口 ${usage.contextWindow.toLocaleString()}` : "（窗口大小在第一轮回复后知道）"}`
              : estPct !== null
                ? `新会话预估约 ${baseContext!.toLocaleString()} tokens（系统提示 + 工具 + CLAUDE.md），首轮回复后更新为实际值`
                : "新会话：首轮回复后显示实际上下文大小"
          }\n点击查看各部分占用（/context）`}
        />
        {usage.costUsd !== null && (
          <span className="q-cost" title="本会话累计花费（按 API 价格估算，订阅账号不实际扣费）">${usage.costUsd.toFixed(2)}</span>
        )}
      </span>
      {onHotCompact && used !== null && (
        <button
          className="hot-compact"
          onClick={onHotCompact}
          title={`上下文已超过 200k，缓存还在（上次回复不到 1 小时），现在 /compact 最便宜${
            hotCompactPct(used, model) !== null ? `，预计约消耗 5 小时额度的 ${pctText(hotCompactPct(used, model)!)}` : ""
          }。\n隔久了再压缩，要按完整上下文重新计费一次。`}
        >
          趁热压缩
        </button>
      )}
    </div>
  );
}
