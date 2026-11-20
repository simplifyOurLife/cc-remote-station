import { useEffect, useRef, useState } from "react";

const GLYPHS = "#%@!&$*<>/\\|=+?01アカサタナ";
export const noise = (n: number) => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join("");
const clock = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

/**
 * 保存按钮：点击后文字乱码跳动（红青错位抖动），保存完成后逐字解码成「已保存 ✓」，按钮上方飘出一行终端风回执；
 * 失败则解码成「保存失败 ✕」并横向故障撕裂一下（错误信息由调用方照常显示）。onSave 返回 false 或抛错都算失败。
 */
export function SaveButton({
  onSave,
  children = "保存",
  savedText = "已保存 ✓",
  receipt = "CONFIG WRITTEN",
}: {
  onSave: () => boolean | void | Promise<boolean | void>;
  children?: string;
  savedText?: string;
  /** 回执里的英文动作名 */
  receipt?: string;
}) {
  const failText = "保存失败 ✕";
  const [state, setState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [text, setText] = useState(children);
  const [decoding, setDecoding] = useState(false);
  const [hud, setHud] = useState<{ ok: boolean; text: string; n: number } | null>(null);
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach((t) => clearInterval(t));
    timers.current = [];
  };
  useEffect(() => clear, []);
  useEffect(() => {
    if (state === "idle") setText(children);
  }, [children, state]);

  /** 从左到右逐字解码成 target，未解出的位置继续跳乱码 */
  const decode = (target: string, done: () => void) => {
    clear();
    setDecoding(true);
    let step = 0;
    const total = target.length * 3;
    timers.current.push(
      window.setInterval(() => {
        step++;
        const fixed = Math.floor(step / 3);
        setText(target.slice(0, fixed) + noise(Math.max(0, target.length - fixed)));
        if (step >= total) {
          clear();
          setText(target);
          setDecoding(false);
          done();
        }
      }, 28),
    );
  };

  const click = async () => {
    clear();
    setState("busy");
    // 保存期间整段乱码跳动，至少跳 0.25 秒，太快了看不到
    timers.current.push(window.setInterval(() => setText(noise(Math.max(children.length, 4))), 45));
    const minWait = new Promise((r) => setTimeout(r, 250));
    let ok: boolean;
    try {
      ok = (await onSave()) !== false;
    } catch {
      ok = false;
    }
    await minWait;
    setState(ok ? "ok" : "fail");
    setHud({ ok, text: ok ? `> ${receipt} · ${clock()}` : "> WRITE FAILED ✕", n: Date.now() });
    decode(ok ? savedText : failText, () => {
      timers.current.push(
        window.setTimeout(() => {
          setState("idle");
          setText(children);
        }, ok ? 1400 : 1800),
      );
    });
  };

  return (
    <span className="save-wrap">
      {hud && (
        <span key={hud.n} className={`save-hud ${hud.ok ? "ok" : "fail"}`} onAnimationEnd={() => setHud(null)}>
          {hud.text}
        </span>
      )}
      <button className={`primary save-btn ${state}${decoding ? " decoding" : ""}`} disabled={state === "busy"} onClick={click}>
        {/* 隐形的尺寸占位：按钮宽度取几种文字里最宽的，乱码和切换时不跳 */}
        <span className="save-sizer" aria-hidden="true">
          <span>{children}</span>
          <span>{savedText}</span>
          <span>{failText}</span>
        </span>
        <span className="save-text">{text}</span>
      </button>
    </span>
  );
}
