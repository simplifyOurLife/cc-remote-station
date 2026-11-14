import { CSSProperties, useEffect, useState } from "react";

const GLYPHS = "アイウエカキクサシスセタチツナニ0123456789ABCDEF<>/\\#$%*+=";
const SEGMENTS = 10;

/** 文字从乱码逐字「解码」成原文，之后每隔一会儿闪一下干扰 */
function useDecode(text: string) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const chars = [...text];
    const noise = (keep: number) =>
      chars.map((c, i) => (i < keep || c === " " ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join("");
    let step = 0;
    let glitch: ReturnType<typeof setTimeout> | undefined;
    const decode = setInterval(() => {
      step += 1;
      setShown(noise(step));
      if (step >= chars.length) clearInterval(decode);
    }, 28);
    // 解码完成后偶尔把一两个字换成乱码再恢复
    const flicker = setInterval(() => {
      if (step < chars.length) return;
      const i = Math.floor(Math.random() * chars.length);
      if (chars[i] === " ") return;
      setShown(chars.map((c, j) => (j === i ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : c)).join(""));
      glitch = setTimeout(() => setShown(text), 90);
    }, 1600);
    return () => {
      clearInterval(decode);
      clearInterval(flicker);
      clearTimeout(glitch);
    };
  }, [text]);
  return shown;
}

/** 格子一个一个出现：1 → 10 个，满了停一下清空重来 */
function useFill() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    // 多走 3 拍：满格停留一下再从 1 开始
    const timer = setInterval(() => setCount((c) => (c >= SEGMENTS + 3 ? 1 : c + 1)), 120);
    return () => clearInterval(timer);
  }, []);
  return Math.min(count, SEGMENTS);
}

/** 赛博风的加载行：逐格增长的流光斜切条 + 解码文字 + 闪烁光标 */
export function Loading({ text, className }: { text: string; className?: string }) {
  const shown = useDecode(text);
  const count = useFill();
  return (
    <div className={`cyber-loading ${className ?? ""}`} role="status" aria-label={text}>
      <span className="cyber-bar" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <i key={i} className={i < count ? "on" : ""} style={{ "--i": i } as CSSProperties} />
        ))}
      </span>
      <span className="cyber-text" aria-hidden="true">
        {shown}
      </span>
      <span className="cyber-cursor" aria-hidden="true">
        ▌
      </span>
    </div>
  );
}
