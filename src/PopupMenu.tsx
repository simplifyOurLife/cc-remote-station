import { CSSProperties, ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GAP = 4;
const EDGE = 8;

/**
 * 挂到 body 上的弹出菜单：不会被页面滚动区或卡片裁掉。
 * 默认从按钮左边对齐向右展开、在下方；右边放不下才右对齐向左，下方放不下才翻到上方。
 */
export function PopupMenu({
  anchor,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 先隐藏渲染一次量尺寸，再定位，避免闪一下
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const m = ref.current?.getBoundingClientRect();
      if (!a || !m) return;
      const { innerWidth: w, innerHeight: h } = window;
      let left = a.left;
      if (left + m.width > w - EDGE) left = a.right - m.width;
      left = Math.max(EDGE, Math.min(left, w - m.width - EDGE));
      let top = a.bottom + GAP;
      if (top + m.height > h - EDGE && a.top - GAP - m.height >= EDGE) top = a.top - GAP - m.height;
      setStyle({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    const inside = (t: EventTarget | null) => [ref, anchor].some((r) => r.current?.contains(t as Node));
    const down = (e: MouseEvent) => !inside(e.target) && onClose();
    const scroll = (e: Event) => !inside(e.target) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("scroll", scroll, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);

  return createPortal(
    // 点任一项后关闭；各项自己的 onClick 先执行
    <div ref={ref} className="menu popup-menu" role="menu" style={style} onClick={onClose}>
      {children}
    </div>,
    document.body,
  );
}
