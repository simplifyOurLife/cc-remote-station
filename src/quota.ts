/**
 * 5 小时额度的「token ↔ 百分比」换算：额度只报已用比例、不报总量，只能拿每轮实际 token 和比例的变化
 * 在本机慢慢积累。终端里、别的设备上的用量也算在同一个额度里，所以估出来偏保守（百分比偏高）。
 */
/** v2：计价权重改成 API 价格比例，旧口径的校准数据不再通用 */
const KEY = "ccws.quotaCalib.v2";
/** 各类 token 相对普通输入的价格（API 计价比例，额度的实际折算未公开） */
const W_READ = 0.1;
const W_WRITE_5M = 1.25;
const W_WRITE_1H = 2;
const W_OUTPUT = 5;
/** 累计观察到这么多个百分点的变化才给估算 */
const READY_PCT = 5;
/** 超过后等比缩小：旧数据逐渐淡出，换套餐、换模型后能跟上 */
const KEEP_PCT = 100;

interface Calib {
  tokens: number;
  pct: number;
}

let calib: Calib = load();
/** 上次采样以来各轮花掉的 token（额度是账号级的，所有会话合在一起算） */
let pending = 0;
let last: { pct: number; resetsAt: unknown } | null = null;

function load(): Calib {
  try {
    const c = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (c?.tokens > 0 && c?.pct > 0) return c;
  } catch {
    // 当作没有数据
  }
  return { tokens: 0, pct: 0 };
}

/** 一轮计入额度的量（result.usage 是本轮合计），按普通输入 token 折算 */
function billed(u: Record<string, any> | undefined): number {
  if (!u) return 0;
  const cc = u.cache_creation;
  // 有分项就按 5 分钟 / 1 小时分别计；没有就按 1 小时（订阅账号实际都是 1 小时）
  const write = cc
    ? (cc.ephemeral_5m_input_tokens ?? 0) * W_WRITE_5M + (cc.ephemeral_1h_input_tokens ?? 0) * W_WRITE_1H
    : (u.cache_creation_input_tokens ?? 0) * W_WRITE_1H;
  return (u.input_tokens ?? 0) + write + (u.cache_read_input_tokens ?? 0) * W_READ + (u.output_tokens ?? 0) * W_OUTPUT;
}

/** 喟入云端 claude 的每个事件：两次 5 小时窗口采样之间花的 token 对应这段时间的比例变化 */
export function observeQuota(e: Record<string, any>) {
  if (e.type === "result") {
    pending += billed(e.usage);
    return;
  }
  if (e.type !== "rate_limit_event") return;
  const w = e.rate_limit_info?.unifiedWindows?.five_hour;
  if (typeof w?.utilization !== "number") return;
  const pct = w.utilization <= 1 ? w.utilization * 100 : w.utilization;
  // 窗口重置过（resetsAt 变了或比例回落）就丢掉这段
  if (last && last.resetsAt === w.resetsAt && pct >= last.pct && pending > 0) {
    calib = { tokens: calib.tokens + pending, pct: calib.pct + pct - last.pct };
    if (calib.pct > KEEP_PCT) calib = { tokens: (calib.tokens * KEEP_PCT) / calib.pct, pct: KEEP_PCT };
    try {
      localStorage.setItem(KEY, JSON.stringify(calib));
    } catch {
      // 存不下只是重启后重新积累
    }
  }
  last = { pct, resetsAt: w.resetsAt };
  pending = 0;
}

/** 花掉这么多（已按 billed 口径折算的）token 大约占 5 小时额度的百分之几；数据不够时为 null */
export function estimatePct(tokens: number): number | null {
  return calib.pct >= READY_PCT ? (tokens * calib.pct) / calib.tokens : null;
}

/** 冷启动把 ctx 个 token 重新写入 1 小时缓存大约占 5 小时额度的百分之几 */
export function coldPct(ctx: number): number | null {
  return estimatePct(ctx * W_WRITE_1H);
}

export function pctText(p: number): string {
  return p < 1 ? "不到 1%" : `${Math.round(p)}%`;
}
