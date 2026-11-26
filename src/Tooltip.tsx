import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DELAY = 350;
const GAP = 8;
const EDGE = 8;
/** 有提示文字的元素（空的 data-tip 不算） */
const HAS_TIP = '[data-tip]:not([data-tip=""])';

/**
 * 让 HTML 元素的 title 根本不落到 DOM 上：setAttribute/removeAttribute("title") 和 el.title 都改写成 data-tip，
 * 系统自带的白框提示就永远不会出现，统一由 TooltipLayer 显示赛博风提示。各处继续写普通的 title 即可。
 *
 * 以前是悬停时才把光标下元素的 title 挪走、离开时还回去，和 React 的更新有竞态：React 删 title 时属性早被挪走，
 * 没有变化记录，data-tip 里留着旧文字，离开时又把旧 title 还了回去，之后漏接一次就冒出系统提示。
 * 要在 React 第一次渲染前调用（main.tsx）。SVG 元素不改（它的 title 属性不出提示）
 */
export function installTitleRedirect() {
  const proto = Element.prototype;
  const setAttr = proto.setAttribute;
  const removeAttr = proto.removeAttribute;
  proto.setAttribute = function (name: string, value: string) {
    if (this instanceof HTMLElement && name.toLowerCase() === "title") this.dataset.tip = String(value);
    else setAttr.call(this, name, value);
  };
  proto.removeAttribute = function (name: string) {
    if (this instanceof HTMLElement && name.toLowerCase() === "title") delete this.dataset.tip;
    else removeAttr.call(this, name);
  };
  Object.defineProperty(HTMLElement.prototype, "title", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.tip ?? "";
    },
    set(this: HTMLElement, v: string) {
      this.dataset.tip = String(v);
    },
  });
  // index.html 里写死的
  document.querySelectorAll<HTMLElement>("[title]").forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    el.dataset.tip = el.getAttribute("title") ?? "";
    removeAttr.call(el, "title");
  });
}

/**
 * 全局悬停提示：光标停在带 data-tip（即写了 title）的元素上，延迟一下显示提示框。
 * - 只有真正离开（mouseout 到外面、鼠标移出窗口）才放开当前元素；
 * - 点击、按键、滚动、窗口失焦只收起提示框，离开前不再弹（对话自动滚动不影响额度、历史列表上的提示）；
 * - React 重新渲染会改提示文字、甚至把光标下的元素整个换掉：MutationObserver 在每批 DOM 变化后重新看光标下是谁，
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
    /** 放开当前元素 */
    const release = () => {
      clearTimeout(timer);
      target = null;
      if (shown) setTip(null);
      shown = false;
      suppressed = false;
    };
    /** 接管光标下的元素；正在显示提示时（如元素被重新渲染换掉了）直接接着显示 */
    const adopt = (el: HTMLElement) => {
      if (el === target) return;
      const wasShown = shown;
      release();
      target = el;
      if (wasShown) show();
      else timer = setTimeout(show, DELAY);
    };
    const owner = (node: Element | null) => node?.closest?.(HAS_TIP) as HTMLElement | null;
    /** 重新看光标下是谁 */
    const sync = () => {
      if (!pos) return;
      const el = owner(document.elementFromPoint(pos.x, pos.y));
      if (!el) release();
      else adopt(el);
    };

    const watch = new MutationObserver((records) => {
      // 当前元素的提示文字变了：正在显示就跟着更新（变空的由下面 sync 放开）
      if (target && shown && target.dataset.tip && records.some((r) => r.type === "attributes" && r.target === target)) show();
      sync();
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tip"] });

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
