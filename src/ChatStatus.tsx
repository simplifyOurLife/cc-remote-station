import { useEffect, useRef, useState } from "react";
import { PermissionMode } from "./api";
import { RateLimit, Usage } from "./chatModel";
import { hostShortTime, HostTz, tzLabel } from "./hostTime";
import { PopupMenu } from "./PopupMenu";
import { estimatePct, pctText } from "./quota";

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

/** 一个额度窗口在状态栏里的一段（如「5h 6% 4h44m」）和悬浮详情里的一行 */
function windowView(short: string, r: RateLimit | undefined, now: number, tz: HostTz | null) {
  const name = r ? (WINDOWS[r.window] ?? r.window) : short;
  if (!r) return { cls: "idle", text: `${short} —`, line: null };
  const remain = r.resetsAt ? r.resetsAt - now : null;
  const at = r.resetsAt ? hostShortTime(r.resetsAt, tz) : "";
  // 已过重置时间：手里的数据是上个窗口的，不再沿用旧状态
  if (remain !== null && remain <= 0) {
    return { cls: "idle", text: `${short} 已重置`, line: `${name}：${at} 已重置，下次回复后刷新` };
  }
  const t = remain !== null ? ` ${left(remain)}` : "";
  if (r.status === "rejected") {
    return { cls: "bad", text: `${short} 用尽${t}`, line: `${name}：已用尽${at ? `，${at} 恢复` : ""}` };
  }
  const pct = r.usedPct;
  const cls = r.status === "allowed_warning" || (pct ?? 0) >= 80 ? "warn" : "ok";
  return {
    cls,
    text: `${short} ${pct !== null ? `${pct}%` : "—"}${t}`,
    line: `${name}：${pct !== null ? `已用 ${pct}%` : "用量未报告"}${r.status === "allowed_warning" ? "（接近上限）" : ""}${at ? `，${at} 重置` : ""}`,
  };
}

/** 输入框上方的状态栏：权限模式（可切换），再是和 CLI 状态栏一样的一行：5h · 7d · ctx · 花费 */
export function ChatStatus({
  mode,
  onMode,
  usage,
  rateLimits,
  tz,
  baseContext,
  onHotCompact,
}: {
  mode: PermissionMode;
  onMode: (m: PermissionMode) => void;
  usage: Usage;
  rateLimits: Record<string, RateLimit>;
  /** 云主机时区：重置时间按 Claude 运行的地方显示 */
  tz: HostTz | null;
  /** 新会话还没回复时用来预估上下文（这台主机上次新会话首轮的大小） */
  baseContext: number | null;
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
  const ctxCls = pct === null ? "" : pct >= 85 ? "bad" : pct >= 60 ? "warn" : "";
  const ctxEst = used === null && baseContext ? (usage.contextWindow ? `~${Math.round((baseContext / usage.contextWindow) * 100)}%` : `~${kTokens(baseContext)}`) : null;

  const h5 = windowView("5h", rateLimits.five_hour, now, tz);
  const d7 = windowView("7d", rateLimits.seven_day, now, tz);
  const list = Object.values(rateLimits);
  const quotaTitle = list.length
    ? [
        ...list.map((r) => windowView("", r, now, tz).line),
        `数据更新于 ${hostShortTime(Math.max(...list.map((r) => r.updatedAt)) / 1000, tz)}（每次回复后刷新）`,
        `时间按${tzLabel(tz)}`,
      ].join("\n")
    : "发一条消息后显示：云端 Claude 每次回复完会报告 5 小时 / 7 天窗口的用量。\n用 API key 按量计费时没有额度，看花费即可。";

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
        <span className="status-quota" title={quotaTitle}>
          <span className={`seg ${h5.cls}`}>{h5.text}</span>
          <span className="sep">·</span>
          <span className={`seg ${d7.cls}`}>{d7.text}</span>
        </span>
        <span className="sep">·</span>
        <span
          className={`seg ${ctxCls} ${used === null ? "est" : ""}`}
          title={
            used !== null
              ? `上下文已用 ${used.toLocaleString()} tokens${usage.contextWindow ? ` / 窗口 ${usage.contextWindow.toLocaleString()}` : "（窗口大小在第一轮回复后知道）"}`
              : ctxEst
                ? `新会话预估约 ${baseContext!.toLocaleString()} tokens（系统提示 + 工具 + CLAUDE.md），首轮回复后更新为实际值`
                : "新会话：首轮回复后显示实际上下文大小"
          }
        >
          ctx {used !== null ? (pct !== null ? `${pct}%` : kTokens(used)) : (ctxEst ?? "新会话")}
        </span>
        <span className="sep">·</span>
        <span className="seg" title="本会话累计花费（按 API 价格估算，订阅账号不实际扣费）">
          {usage.costUsd !== null ? `$${usage.costUsd.toFixed(2)}` : "$—"}
        </span>
      </span>
      {onHotCompact && used !== null && (
        <button
          className="hot-compact"
          onClick={onHotCompact}
          title={`上下文已超过 200k，缓存还在（上次回复不到 1 小时），现在 /compact 最便宜${
            estimatePct(used / 10) !== null ? `，预计约消耗 5 小时额度的 ${pctText(estimatePct(used / 10)!)}` : ""
          }。\n隔久了再压缩，要按完整上下文重新计费一次。`}
        >
          趁热压缩
        </button>
      )}
    </div>
  );
}
