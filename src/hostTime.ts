import { useEffect, useState } from "react";
import { api } from "./api";

/** 云主机的时区：IANA 名优先（夏令时自动对），拿不到就用当前 UTC 偏移 */
export interface HostTz {
  iana: string | null;
  offsetMin: number;
}

const cache = new Map<string, Promise<HostTz>>();

/** 取主机时区（每台主机只问一次）；没拿到之前为 null，格式化时暂用本机时区 */
export function useHostTz(hostId: string): HostTz | null {
  const [tz, setTz] = useState<HostTz | null>(null);
  useEffect(() => {
    let p = cache.get(hostId);
    if (!p) {
      p = api.hostTimezone(hostId);
      cache.set(hostId, p);
      // 失败了下次再问
      p.catch(() => cache.delete(hostId));
    }
    p.then(setTz).catch(() => {});
  }, [hostId]);
  return tz;
}

function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 把 Unix 秒换成「在主机时区里」的日期对象 + 格式化用的时区名 */
function zoned(sec: number, tz: HostTz | null): { date: Date; timeZone?: string } {
  if (tz?.iana && validZone(tz.iana)) return { date: new Date(sec * 1000), timeZone: tz.iana };
  // 只有偏移：先把时间挑平偏移，再按 UTC 格式化
  if (tz) return { date: new Date((sec + tz.offsetMin * 60) * 1000), timeZone: "UTC" };
  return { date: new Date(sec * 1000) };
}

/** 主机时区的日期 + 时间，如 2026/11/14 10:23:45 */
export function hostDateTime(sec: number, tz: HostTz | null): string {
  const { date, timeZone } = zoned(sec, tz);
  return date.toLocaleString("zh-CN", { timeZone, hour12: false });
}

/** 主机时区的时:分；不是主机上的「今天」就带上月/日 */
export function hostShortTime(sec: number, tz: HostTz | null): string {
  const { date, timeZone } = zoned(sec, tz);
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const time = date.toLocaleTimeString("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  if (day(date) === day(zoned(Date.now() / 1000, tz).date)) return time;
  const md = date.toLocaleDateString("zh-CN", { timeZone, month: "numeric", day: "numeric" });
  return `${md} ${time}`;
}

/** 时区说明，放在提示里 */
export function tzLabel(tz: HostTz | null): string {
  if (!tz) return "本机时区（还没读到云主机时区）";
  const sign = tz.offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(tz.offsetMin);
  const off = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `云主机时间 ${tz.iana ? `${tz.iana}，` : ""}${off}`;
}
