import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DELAY = 350;
const GAP = 8;
const EDGE = 8;

/**
 * 全局悬停提示：接管所有带 title 的元素。悬停时把 title 挪到 data-tip（压掉系统自带的提示），
 * 延迟一下显示赛博风的提示框；移开、点击、滚动、按键时收起并把 title 还回去。
 * 各处继续写普通的 title 即可。
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const restore = () => {
      clearTimeout(timer);
      if (target) {
        // React 重新渲染时可能已经把新的 title 写回去了，那就以它为准
        if (!target.hasAttribute("title") && target.dataset.tip !== undefined) target.setAttribute("title", target.dataset.tip);
        delete target.dataset.tip;
        target = null;
      }
      setTip(null);
    };

    const over = (e: MouseEvent) => {
      const node = e.target as Element | null;
      if (!node?.closest) return;
      // 还在当前元素（或它的子元素）里移动
      if (target && target.contains(node)) return;
      const el = node.closest("[title]") as HTMLElement | null;
      restore();
      const text = el?.getAttribute("title");
      if (!el || !text?.trim()) return;
      target = el;
      el.dataset.tip = text;
      el.removeAttribute("title");
      timer = setTimeout(() => {
        if (target === el && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() });
      }, DELAY);
    };

    const out = (e: MouseEvent) => {
      if (target && !target.contains(e.relatedTarget as Node | null)) restore();
    };

    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("mousedown", restore, true);
    document.addEventListener("keydown", restore, true);
    document.addEventListener("scroll", restore, true);
    window.addEventListener("blur", restore);
    return () => {
      restore();
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("mousedown", restore, true);
      document.removeEventListener("keydown", restore, true);
      document.removeEventListener("scroll", restore, true);
      window.removeEventListener("blur", restore);
    };
  }, []);

  // 先隐藏渲染量尺寸，再放到元素下方居中；下面放不下翻到上方，左右不出窗口
  useLayoutEffect(() => {
    if (!tip || !ref.current) {
      setStyle({ visibility: "hidden" });
      return;
    }
    const t = ref.current.getBoundingClientRect();
    const { rect } = tip;
    let top = rect.bottom + GAP;
    if (top + t.height > window.innerHeight - EDGE && rect.top - GAP - t.height >= EDGE) top = rect.top - GAP - t.height;
    const left = Math.max(EDGE, Math.min(rect.left + rect.width / 2 - t.width / 2, window.innerWidth - t.width - EDGE));
    setStyle({ top, left });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="cyber-tip" role="tooltip" style={style}>
      {tip.text}
    </div>,
    document.body,
  );
}
