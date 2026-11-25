/**
 * 5 小时额度的估算：额度只报已用比例、不报总量，只能拿实际花费和比例的变化在本机慢慢积累。
 * - 通用口径「每美元占百分之几」：result.total_cost_usd（CLI 按模型价格算好的，含子代理）对两次 5H 采样之间的涨幅。
 * - 冷启动单独实测：发送前后各取一次 5H 比例，记「上下文 token → 涨了多少」。整轮（含后续每次工具调用重读
 *   全量上下文）都算在里面，不用猜缓存读写的权重。
 * 终端里、别的设备上的用量也算在同一个额度里，所以估出来偏保守（百分比偏高）。
 *
 * 实测（2026-11）：rate_limit_event 只在进程第一次请求时来一次，所以另外用 get_usage 的回执补采样。
 */
import { api } from "./api";

/** v3：从「等价 token」改成按美元；冷启动单独校准 */
const KEY = "ccws.quotaCalib.v3";
/** 累计观察到这么多个百分点的变化才给估算（比例只精确到 1%） */
const READY_PCT = 5;
const COLD_READY_PCT = 3;
/** 超过后等比缩小：旧数据逐渐淡出，换套餐后能跟上 */
const KEEP_PCT = 100;
const COLD_KEEP_PCT = 30;

interface Calib {
  usd: number;
  pct: number;
  /** 实测过的冷启动：上下文 token 合计、对应的涨幅合计 */
  coldTokens: number;
  coldPct: number;
}

let calib: Calib = load();
/** 上次采样以来花掉的美元（额度是账号级的，所有对话合在一起算） */
let pendingUsd = 0;
/** 各对话进程上次报告的累计花费 */
const costs = new Map<string, number>();
let last: { pct: number; resetsAt: number } | null = null;
/** 正在实测的冷启动：started = 这轮已有回复（之后的采样不能当「发送前」），done = 这轮结束了 */
let cold: { hostId: string; ctx: number; before: { pct: number; resetsAt: number } | null; started: boolean; done: boolean } | null = null;

function load(): Calib {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (c?.usd > 0 && c?.pct > 0) return { coldTokens: 0, coldPct: 0, ...c };
  } catch {
    // 当作没有数据
  }
  return { usd: 0, pct: 0, coldTokens: 0, coldPct: 0 };
}

function save(hostId: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(calib));
  } catch {
    // 存不下只是重启后重新积累
  }
  log(hostId, "calib", {
    ...calib,
    pctPerUsd: calib.usd ? calib.pct / calib.usd : null,
    coldPctPer100k: calib.coldTokens ? (calib.coldPct * 1e5) / calib.coldTokens : null,
  });
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

const sameWindow = (a: { resetsAt: number }, b: { resetsAt: number }) => Math.abs(a.resetsAt - b.resetsAt) < 120;

/** 一次 5H 比例采样（0–100，resetsAt 秒） */
function sample(pct: number, resetsAt: number, source: string, hostId: string) {
  const cur = { pct, resetsAt };
  // 窗口重置过（resetsAt 变了或比例回落）就丢掉这段
  const counted = !!last && sameWindow(last, cur) && pct >= last.pct && pendingUsd > 0;
  log(hostId, "sample", { source, pct, resetsAt, prevPct: last?.pct ?? null, usdSince: pendingUsd, counted });
  if (counted) {
    calib = { ...calib, usd: calib.usd + pendingUsd, pct: calib.pct + pct - last!.pct };
    if (calib.pct > KEEP_PCT) calib = { ...calib, usd: (calib.usd * KEEP_PCT) / calib.pct, pct: KEEP_PCT };
    save(hostId);
  }
  pendingUsd = 0;
  last = cur;

  if (!cold) return;
  if (!cold.started) cold.before = cur;
  else if (cold.done) {
    const b = cold.before;
    const ok = !!b && sameWindow(b, cur) && pct >= b.pct;
    log(cold.hostId, "cold_result", { ctx: cold.ctx, before: b?.pct ?? null, after: pct, delta: b ? pct - b.pct : null, counted: ok });
    if (ok) {
      calib = { ...calib, coldTokens: calib.coldTokens + cold.ctx, coldPct: calib.coldPct + pct - b!.pct };
      if (calib.coldPct > COLD_KEEP_PCT) calib = { ...calib, coldTokens: (calib.coldTokens * COLD_KEEP_PCT) / calib.coldPct, coldPct: COLD_KEEP_PCT };
      save(cold.hostId);
    }
    cold = null;
  }
}

/**
 * 喂入云端 claude 的每个事件（chatId 区分对话进程，total_cost_usd 是进程内累计；hostId 决定埋点写到哪台主机）。
 * 返回 true 表示冷启动这轮刚结束，调用方应马上查一次 get_usage 作为「发送后」的采样。
 */
export function observeQuota(e: Record<string, any>, chatId: string | null, hostId: string): boolean {
  if (e.type === "assistant" && cold) cold.started = true;
  if (e.type === "result") {
    const key = chatId ?? "";
    const total = typeof e.total_cost_usd === "number" ? e.total_cost_usd : 0;
    const prev = costs.get(key) ?? 0;
    const usd = total >= prev ? total - prev : total;
    pendingUsd += usd;
    costs.set(key, total);
    const u = e.usage ?? {};
    log(hostId, "turn", {
      session: e.session_id,
      models: Object.keys(e.modelUsage ?? {}),
      usd,
      calls: Array.isArray(u.iterations) ? u.iterations.length : null,
      input: u.input_tokens,
      write: u.cache_creation_input_tokens,
      read: u.cache_read_input_tokens,
      output: u.output_tokens,
      durationMs: e.duration_ms,
      cold: !!cold?.started,
    });
    if (cold?.started) {
      cold.done = true;
      return true;
    }
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
  if (e.type === "exit") costs.delete(chatId ?? "");
  return false;
}

/** 用户确认按冷启动发出：开始实测这一轮（发送前的比例取最近一次采样，回复前到的采样会更新它）；info 是给埋点的当时情形 */
export function startCold(hostId: string, ctx: number, info: Record<string, unknown>) {
  cold = { hostId, ctx, before: last, started: false, done: false };
  log(hostId, "cold_start", { ctx, beforePct: last?.pct ?? null, ...info });
}

/** 各模型普通输入的 API 价格（美元 / 百万 token）；缓存写入 1 小时 ×2，缓存读 ×0.1，输出 ×5 */
function inputPrice(model: string | null): number {
  if (model && /haiku/i.test(model)) return 1;
  if (model && /sonnet/i.test(model)) return 3;
  return 5;
}

function usdPct(usd: number): number | null {
  return calib.pct >= READY_PCT ? (usd * calib.pct) / calib.usd : null;
}

/**
 * 冷启动这一轮大约占 5 小时额度的百分之几：有实测数据就用实测（measured）；
 * 否则按价格给区间——低值只算整段重新写入缓存，高值再加约 10 次工具调用各重读一遍上下文。
 */
export function coldEstimate(ctx: number, model: string | null): { lo: number; hi: number; measured: boolean } | null {
  if (calib.coldPct >= COLD_READY_PCT) {
    const v = (ctx * calib.coldPct) / calib.coldTokens;
    return { lo: v, hi: v, measured: true };
  }
  const p = (ctx * inputPrice(model)) / 1e6;
  const lo = usdPct(p * 2);
  const hi = usdPct(p * 3);
  return lo === null || hi === null ? null : { lo, hi, measured: false };
}

/** 缓存还在时 /compact 大约占百分之几：重读一遍上下文 + 约 4k 的摘要输出 */
export function hotCompactPct(ctx: number, model: string | null): number | null {
  return usdPct(((ctx * 0.1 + 4000 * 5) * inputPrice(model)) / 1e6);
}

export function pctText(p: number): string {
  return p < 1 ? "不到 1%" : `${Math.round(p)}%`;
}

/** 区间：两端取整后相同就只写一个数 */
export function rangeText(r: { lo: number; hi: number }): string {
  const lo = pctText(r.lo);
  const hi = pctText(r.hi);
  return lo === hi ? lo : r.lo < 1 ? `不到 1%–${hi}` : `${Math.round(r.lo)}%–${hi}`;
}
