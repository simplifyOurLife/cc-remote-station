import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DELAY = 350;
const GAP = 8;
const EDGE = 8;

/**
 * 全局悬停提示：接管所有带 title 的元素。悬停时把 title 挪到 data-tip（压掉系统自带的提示），
 * 延迟一下显示赛博风的提示框。各处继续写普通的 title 即可。
 *
 * 系统提示只看「光标下的元素此刻有没有 title」，所以只要鼠标还在元素上，title 就一直不能还回去：
 * - 只有真正离开（mouseout 到外面、鼠标移出窗口）才还 title；
 * - 点击、按键、滚动、窗口失焦只收起提示框（离开前不再弹），不还 title。
 *   以前这些情况会还 title：Claude 回复时消息区不停自动滚动，悬停中的额度、历史会话、耗时标签就被还回
 *   title，鼠标不动也不会再有 mouseover，系统提示就冲出来了；
 * - React 重新渲染会写回 title、甚至把光标下的元素整个换掉（新元素带着 title）：
 *   全局 MutationObserver 在每批 DOM 变化后（微任务里，浏览器更新系统提示之前）重新看光标下是谁并接管，
 *   滚动后也同样重新看一次。
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 提示框是否正在显示；收起后在离开当前元素前不再弹 */
    let shown = false;
    let suppressed = false;
    /** 最后的鼠标位置；不在窗口里时为 null */
    let pos: { x: number; y: number } | null = null;

    const show = () => {
      if (!target?.isConnected || suppressed) return;
      shown = true;
      setTip({ text: target.dataset.tip ?? "", rect: target.getBoundingClientRect() });
    };
    const hide = () => {
      clearTimeout(timer);
      if (shown) setTip(null);
      shown = false;
      suppressed = true;
    };
    /** 把 title 还给当前元素并放开它 */
    const release = () => {
      clearTimeout(timer);
      if (target) {
        if (!target.hasAttribute("title") && target.dataset.tip !== undefined) target.setAttribute("title", target.dataset.tip);
        delete target.dataset.tip;
        target = null;
      }
      if (shown) setTip(null);
      shown = false;
      suppressed = false;
    };
    /** 把元素当前的 title 挑走存到 data-tip */
    const take = (el: HTMLElement) => {
      const text = el.getAttribute("title");
      if (text == null) return;
      el.dataset.tip = text;
      el.removeAttribute("title");
    };
    /** 接管光标下的元素；正在显示提示时（如元素被重新渲染换掉了）直接接着显示 */
    const adopt = (el: HTMLElement) => {
      if (el === target) return;
      const wasShown = shown;
      release();
      take(el);
      if (!el.dataset.tip?.trim()) {
        delete el.dataset.tip;
        return;
      }
      target = el;
      if (wasShown) show();
      else timer = setTimeout(show, DELAY);
    };
    /** 从某个节点往上找带提示的元素（当前接管的元素 title 已经挪到 data-tip 了） */
    const owner = (node: Element | null) => node?.closest?.("[title], [data-tip]") as HTMLElement | null;
    /** 重新看光标下是谁 */
    const sync = () => {
      if (!pos) return;
      const el = owner(document.elementFromPoint(pos.x, pos.y));
      if (!el) release();
      else adopt(el);
    };

    const watch = new MutationObserver((records) => {
      // 当前元素的 title 被 React 写回来（内容变了）：再挑走，提示文字跟着更新
      if (target && records.some((r) => r.type === "attributes" && r.target === target) && target.hasAttribute("title")) {
        take(target);
        if (shown) show();
      }
      sync();
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

    const move = (e: MouseEvent) => {
      pos = { x: e.clientX, y: e.clientY };
    };
    const over = (e: MouseEvent) => {
      pos = { x: e.clientX, y: e.clientY };
      const el = owner(e.target as Element | null);
      if (!el) release();
      else adopt(el);
    };
    const out = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      if (!to) {
        // 移出窗口
        pos = null;
        release();
      } else if (target && !target.contains(to)) {
        // 进入的元素会在它自己的 mouseover 里接管，这里只管放开
        release();
      }
    };
    let scrollFrame = 0;
    const scroll = (e: Event) => {
      // 只有当前元素跟着滚动了才收起（对话自动滚到底不影响额度、历史列表上的提示）
      const src = e.target;
      if (target && (src === document || (src instanceof Node && src.contains(target)))) hide();
      if (!scrollFrame)
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0;
          sync();
        });
    };

    document.addEventListener("mousemove", move, { passive: true });
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", hide);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(scrollFrame);
      release();
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", hide);
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
