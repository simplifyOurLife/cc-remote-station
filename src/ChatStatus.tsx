import { useRef, useState } from "react";
import { PermissionMode } from "./api";
import { RateLimit, Usage } from "./chatModel";
import { hostShortTime, HostTz, tzLabel } from "./hostTime";
import { PopupMenu } from "./PopupMenu";

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
const SEVERITY: Record<string, number> = { rejected: 3, allowed_warning: 2, allowed: 1 };

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function quota(limits: Record<string, RateLimit>, tz: HostTz | null) {
  const resetText = (at: number | null) => (at ? hostShortTime(at, tz) : "");
  const list = Object.values(limits);
  if (!list.length) {
    return {
      cls: "idle",
      text: "额度 —",
      title: "发一条消息后显示：云端 Claude 每次回复完会报告 5 小时 / 7 天窗口的用量。\n用 API key 按量计费时没有额度，看花费即可。",
    };
  }
  // 显示最紧张的那个窗口：先比状态，状态一样比已用比例
  const rank = (r: RateLimit) => (SEVERITY[r.status] ?? 0) * 1000 + (r.usedPct ?? 0);
  const worst = list.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const label = worst.status === "rejected" ? "已用尽" : worst.status === "allowed_warning" ? "接近上限" : "正常";
  const cls = worst.status === "rejected" ? "bad" : worst.status === "allowed_warning" ? "warn" : "ok";
  const reset = resetText(worst.resetsAt);
  const short = (WINDOWS[worst.window] ?? worst.window).replace("窗口", "").trim();
  const text = `额度 ${worst.usedPct !== null ? `${short} ${worst.usedPct}%` : label}${reset ? ` · ${reset} 重置` : ""}`;
  const lines = list.map((r) => {
    const name = WINDOWS[r.window] ?? r.window;
    const st = r.status === "rejected" ? "已用尽" : r.status === "allowed_warning" ? "接近上限" : "正常";
    return `${name}：${st}${r.usedPct !== null ? `，已用 ${r.usedPct}%` : ""}${r.resetsAt ? `，${resetText(r.resetsAt)} 重置` : ""}`;
  });
  const updated = Math.max(...list.map((r) => r.updatedAt));
  lines.push(`数据更新于 ${hostShortTime(updated / 1000, tz)}（每次回复后刷新）`, `时间按${tzLabel(tz)}`);
  return { cls, text, title: lines.join("\n") };
}

/** 输入框上方的状态栏：权限模式（可切换）· 上下文占用 · 本会话花费 · 订阅额度 */
export function ChatStatus({
  mode,
  onMode,
  usage,
  rateLimits,
  tz,
}: {
  mode: PermissionMode;
  onMode: (m: PermissionMode) => void;
  usage: Usage;
  rateLimits: Record<string, RateLimit>;
  /** 云主机时区：重置时间按 Claude 运行的地方显示 */
  tz: HostTz | null;
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const cur = MODES.find((m) => m.value === mode) ?? MODES[0];
  const used = usage.contextUsed;
  const pct = used !== null && usage.contextWindow ? Math.min(100, Math.round((used / usage.contextWindow) * 100)) : null;
  const level = pct === null ? "" : pct >= 85 ? "bad" : pct >= 60 ? "warn" : "ok";
  const q = quota(rateLimits, tz);

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

      <span
        className={`ctx-meter ${level}`}
        title={
          used !== null
            ? `上下文已用 ${used.toLocaleString()} tokens${usage.contextWindow ? ` / 窗口 ${usage.contextWindow.toLocaleString()}` : "（窗口大小在第一轮回复后知道）"}`
            : "发一条消息、或继续一个历史会话后显示"
        }
      >
        上下文
        <span className="ctx-bar" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => (
            <i key={i} className={pct !== null && i < Math.ceil(pct / 10) ? "on" : ""} />
          ))}
        </span>
        {used === null ? "—" : pct !== null ? `${pct}% · ${kTokens(used)}/${kTokens(usage.contextWindow!)}` : kTokens(used)}
      </span>

      <span className="status-item" title="本会话累计花费（按 API 价格估算，订阅账号不实际扣费）">
        本会话 {usage.costUsd !== null ? `$${usage.costUsd.toFixed(2)}` : "—"}
      </span>

      <span className={`quota-chip ${q.cls}`} title={q.title}>
        {q.text}
      </span>
    </div>
  );
}
