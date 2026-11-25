import { ReactNode, useEffect, useState } from "react";
import { hud } from "./copy";

/** onClick 的结果：字符串是成功回执，false 是失败，其它按「已刷新」 */
type Result = string | false | null | undefined | void;

/**
 * 刷新类按钮：点了显示「刷新中」转圈（至少 400ms，免得一闪而过看不出），完成后鼠标旁飘回执、按钮闪一下。
 * 两种完成方式：onClick 返回 Promise 就等它；数据靠别处推回来的（如控制请求回执），传 busy，等它变回 false 再用 result() 取结果。
 */
export function RefreshButton(p: {
  onClick: () => unknown;
  busy?: boolean;
  result?: () => Result;
  onDone?: (ok: boolean) => void;
  className?: string;
  children?: ReactNode;
}) {
  const [spinning, setSpinning] = useState(false);
  /** 已过最短转圈时间、等 busy 落下 */
  const [waiting, setWaiting] = useState(false);

  const finish = (r: Result) => {
    setSpinning(false);
    setWaiting(false);
    hud(r === false ? "> 刷新失败 ✕" : r || "> 已刷新", r !== false);
    p.onDone?.(r !== false);
  };

  const click = async () => {
    setSpinning(true);
    const [r] = await Promise.all([Promise.resolve(p.onClick()).catch(() => false as const), new Promise((ok) => setTimeout(ok, 400))]);
    if (p.busy === undefined) finish(r as Result);
    else setWaiting(true);
  };

  useEffect(() => {
    if (!waiting) return;
    if (!p.busy) return finish(p.result?.());
    // 回执丢了（如云端进程已退出）也别一直转
    const t = setTimeout(() => finish(false), 20000);
    return () => clearTimeout(t);
  }, [waiting, p.busy]);

  return (
    <button className={`refresh-btn ${p.className ?? ""}`} onClick={click} disabled={spinning}>
      {spinning ? (
        <>
          刷新中
          <span className="spinner" />
        </>
      ) : (
        p.children ?? "刷新"
      )}
    </button>
  );
}
