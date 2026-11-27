/**
 * 冷启动（缓存过期后继续旧会话）占 5 小时额度多少的估算。
 *
 * 5H 比例是整个账号的：别的机器、终端里的 claude 也在推它，应用只看得到自己对话的花费，
 * 所以「美元 → 百分比」的通用换算会随别处用量漂移（实测 2026-11 从 $3.3/% 漂到 $2/%），不能用。
 * 能测准的只有冷启动第一次调用：把整段上下文重新写入缓存，几秒内比例跳一截。
 * 于是只实测这一步：发送前最后一次采样 → 第一次调用结束（出现第二次调用或本轮结束）后马上查一次。
 * 期间别的对话有动静就丢掉这个样本；样本按模型分开，取中位数抵消 1% 的取整和偶发污染。
 *
 * 实测（2026-11-25/26，Opus）：146k 上下文 11 秒内 +5%，77k 8 秒内 +3%，约每 10 万 token 3.5%。
 * rate_limit_event 只在进程第一次请求时来一次，采样主要靠 get_usage 回执。
 */
import { api } from "./api";

const KEY = "ccws.quotaCold.v4";
type Family = "opus" | "sonnet" | "haiku";
/** 还没实测时的默认值（每 10 万 token 占百分之几）：Opus 实测，其余按输入价等比 */
const DEFAULT_PER_100K: Record<Family, number> = { opus: 3.5, sonnet: 2.1, haiku: 0.7 };
/** 上下文太小时涨幅只有 0–1%，取整误差比信号大，不记 */
const MIN_CTX = 50_000;
/** 每个模型留最近几个样本 */
const KEEP = 9;

const family = (model: string | null): Family => (model && /haiku/i.test(model) ? "haiku" : model && /sonnet/i.test(model) ? "sonnet" : "opus");

type Point = { pct: number; resetsAt: number };

let samples: Record<Family, number[]> = load();
let last: Point | null = null;
/** 各对话进程本轮见过的消息 id（一条 id 一次 API 调用） */
const calls = new Map<string, Set<string>>();
/**
 * 正在实测的冷启动。before = 第一次回复前最近的采样；first = 第一次调用的消息 id；
 * closing = 第一次调用已结束，等下一次采样当「之后」；dirty = 期间别的会话有动静
 */
let cold: {
  hostId: string;
  session: string | null;
  ctx: number;
  family: Family;
  before: Point | null;
  first: string | null;
  closing: boolean;
  dirty: boolean;
} | null = null;

function load(): Record<Family, number[]> {
  const empty = { opus: [], sonnet: [], haiku: [] };
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return empty;
  }
}

/** 埋点：按主机攒几秒再追加到云端 ~/.cache/cc-workstation/quota.jsonl，排查估算问题时云端 Claude 直接读 */
const logBuf = new Map<string, string[]>();
let logTimer = 0;
function log(hostId: string, kind: string, data: Record<string, unknown>) {
  logBuf.set(hostId, [...(logBuf.get(hostId) ?? []), JSON.stringify({ t: new Date().toISOString(), kind, ...data })]);
  if (!logTimer) logTimer = window.setTimeout(flushLog, 3000);
}
function flushLog() {
  logTimer = 0;
  for (const [hostId, lines] of logBuf) api.quotaLog(hostId, lines.join("\n") + "\n").catch(() => {});
  logBuf.clear();
}

const sameWindow = (a: Point, b: Point) => Math.abs(a.resetsAt - b.resetsAt) < 120;

/** 一次 5H 比例采样（0–100，resetsAt 秒） */
function sample(pct: number, resetsAt: number, source: string, hostId: string) {
  const cur = { pct, resetsAt };
  log(hostId, "sample", { source, pct, resetsAt, prevPct: last?.pct ?? null });
  last = cur;
  if (!cold) return;
  if (!cold.first) cold.before = cur;
  else if (cold.closing) finishCold(cur);
}

function finishCold(after: Point) {
  const c = cold!;
  cold = null;
  const b = c.before;
  const delta = b && sameWindow(b, after) && after.pct >= b.pct ? after.pct - b.pct : null;
  const counted = delta !== null && !c.dirty && c.ctx >= MIN_CTX;
  const per100k = delta === null ? null : (delta * 1e5) / c.ctx;
  log(c.hostId, "cold_result", { ctx: c.ctx, family: c.family, before: b?.pct ?? null, after: after.pct, delta, per100k, dirty: c.dirty, counted });
  if (!counted) return;
  samples = { ...samples, [c.family]: [...samples[c.family], per100k!].slice(-KEEP) };
  try {
    localStorage.setItem(KEY, JSON.stringify(samples));
  } catch {
    // 存不下只是重启后重新积累
  }
  log(c.hostId, "calib", { samples });
}

/**
 * 喂入云端 claude 的每个事件（chatId 区分对话进程；hostId 决定埋点写到哪台主机）。
 * 返回 true 表示冷启动的第一次调用刚结束，调用方应马上查一次 get_usage 作为「之后」的采样。
 */
export function observeQuota(e: Record<string, any>, chatId: string | null, hostId: string): boolean {
  const key = chatId ?? "";
  const mine = !!cold && !!e.session_id && e.session_id === cold.session;
  if (cold && e.session_id && !mine && (e.type === "assistant" || e.type === "result")) cold.dirty = true;

  if (e.type === "assistant") {
    const id = e.message?.id;
    if (id) calls.set(key, (calls.get(key) ?? new Set()).add(id));
    if (mine && id && !cold!.closing) {
      if (!cold!.first) cold!.first = id;
      else if (id !== cold!.first) return (cold!.closing = true);
    }
    return false;
  }
  if (e.type === "result") {
    const u = e.usage ?? {};
    log(hostId, "turn", {
      session: e.session_id,
      models: Object.keys(e.modelUsage ?? {}),
      usd: e.total_cost_usd,
      calls: calls.get(key)?.size ?? 0,
      input: u.input_tokens,
      write: u.cache_creation_input_tokens,
      read: u.cache_read_input_tokens,
      output: u.output_tokens,
      durationMs: e.duration_ms,
      cold: mine,
    });
    calls.delete(key);
    // 只调用了一次就结束（直接回复）：第一次调用到这里才算完
    if (mine && cold!.first && !cold!.closing) return (cold!.closing = true);
    // 没回复就结束了（报错、被中断）：这次不算
    if (mine && !cold!.first) cold = null;
    return false;
  }
  if (e.type === "rate_limit_event") {
    const w = e.rate_limit_info?.unifiedWindows?.five_hour;
    if (typeof w?.utilization === "number") sample(w.utilization <= 1 ? w.utilization * 100 : w.utilization, Number(w.resetsAt), "event", hostId);
  } else if (e.type === "control_response") {
    // get_usage 的回执：utilization 已经是 0–100，resets_at 是 ISO 时间
    const w = e.response?.response?.rate_limits?.five_hour;
    const t = w?.resets_at ? Date.parse(w.resets_at) : NaN;
    if (typeof w?.utilization === "number" && !isNaN(t)) sample(w.utilization, t / 1000, "get_usage", hostId);
  }
  if (e.type === "exit") calls.delete(key);
  return false;
}

/** 用户确认按冷启动发出：开始实测（「之前」取最近一次采样，第一次回复前到的采样会更新它）；info 是给埋点的当时情形 */
export function startCold(hostId: string, session: string | null, ctx: number, model: string | null, info: Record<string, unknown>) {
  cold = { hostId, session, ctx, family: family(model), before: last, first: null, closing: false, dirty: false };
  log(hostId, "cold_start", { ctx, session, model, beforePct: last?.pct ?? null, ...info });
}

/** 重新写入 10 万 token 缓存占百分之几：实测 2 次以上取中位数，只有 1 次就和默认值折中 */
function per100k(model: string | null): { v: number; measured: number } {
  const f = family(model);
  const s = [...samples[f]].sort((a, b) => a - b);
  if (!s.length) return { v: DEFAULT_PER_100K[f], measured: 0 };
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { v: s.length >= 2 ? mid : (mid + DEFAULT_PER_100K[f]) / 2, measured: s.length };
}

/** 冷启动重建缓存（只算第一次调用）大约占 5 小时额度的百分之几；measured = 用了几次实测 */
export function coldEstimate(ctx: number, model: string | null): { pct: number; measured: number } {
  const k = per100k(model);
  return { pct: (ctx * k.v) / 1e5, measured: k.measured };
}

/**
 * 缓存还在时 /compact 大约占百分之几，按缓存写入折算：重读一遍上下文（缓存读是 1 小时写入价的 1/20）
 * + 约 4k 摘要输出（输出价是写入价的 2.5 倍，折合 1 万写入）
 */
export function hotCompactPct(ctx: number, model: string | null): number {
  return ((ctx * 0.05 + 10_000) * per100k(model).v) / 1e5;
}

export function pctText(p: number): string {
  return p < 1 ? "不到 1%" : `${Math.round(p)}%`;
}
