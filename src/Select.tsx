import { CSSProperties, KeyboardEvent, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loading } from "./Loading";

/**
 * 工具风格的下拉框，取代原生 <select> / <datalist>（WebView2 里它们的弹出列表无法用 CSS 改）。
 * 列表挂到 body 上用 fixed 定位，不会被对话框/卡片的切角 clip-path 和滚动区裁掉。
 */
export interface Option<T extends string = string> {
  value: T;
  label?: ReactNode;
  /** 右侧灰字说明 */
  hint?: string;
}

const MAX_HEIGHT = 280;

/** 计算弹出列表位置：默认在下方，下方放不下且上方更宽裕时翻到上方 */
function usePopupPosition(anchor: React.RefObject<HTMLElement | null>, open: boolean) {
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8;
      const up = below < 160 && r.top > below;
      setStyle({
        left: Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 8),
        minWidth: r.width,
        maxHeight: Math.min(MAX_HEIGHT, (up ? r.top : below) - 8),
        ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchor]);
  return style;
}

/** 点在组件和列表以外就关闭；外层滚动也关闭（列表是 fixed 的，不会跟着走） */
function useDismiss(refs: React.RefObject<HTMLElement | null>[], open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => refs.some((r) => r.current?.contains(t as Node));
    const down = (e: MouseEvent) => !inside(e.target) && close();
    const scroll = (e: Event) => !inside(e.target) && close();
    document.addEventListener("mousedown", down);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("scroll", scroll, true);
    };
  });
}

function OptionList<T extends string>(p: {
  listRef: React.RefObject<HTMLDivElement | null>;
  style: CSSProperties;
  options: Option<T>[];
  selected?: string;
  active: number;
  setActive: (i: number) => void;
  pick: (v: T) => void;
  empty?: string;
  /** 建议还在加载时显示的提示 */
  loading?: string;
}) {
  useEffect(() => {
    p.listRef.current?.querySelector(".select-option.active")?.scrollIntoView({ block: "nearest" });
  }, [p.active, p.listRef]);
  return createPortal(
    <div ref={p.listRef} className="select-popup" role="listbox" style={p.style}>
      {p.options.map((o, i) => (
        <div
          key={o.value}
          role="option"
          aria-selected={o.value === p.selected}
          className={`select-option ${i === p.active ? "active" : ""} ${o.value === p.selected ? "selected" : ""}`}
          // mousedown 阻止默认，输入框不会先失焦
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => p.setActive(i)}
          onClick={() => p.pick(o.value)}
        >
          <span className="select-option-label">{o.label ?? o.value}</span>
          {o.hint && <span className="muted select-option-hint">{o.hint}</span>}
        </div>
      ))}
      {p.loading && (
        <div className="select-option select-loading">
          <Loading text={p.loading} />
        </div>
      )}
      {p.options.length === 0 && !p.loading && p.empty && <div className="select-option muted">{p.empty}</div>}
    </div>,
    document.body,
  );
}

/** 列表里用上下键移动、回车选中、Esc 关闭；返回 true 表示已处理 */
function navKey(e: KeyboardEvent, n: number, active: number, setActive: (i: number) => void, choose: () => void, close: () => void) {
  if (e.key === "ArrowDown") setActive(n ? (active + 1) % n : -1);
  else if (e.key === "ArrowUp") setActive(n ? (active - 1 + n) % n : -1);
  else if (e.key === "Enter" && active >= 0) choose();
  else if (e.key === "Escape") close();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}

/** 只能从列表里选的下拉框 */
export function Select<T extends string>(p: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const style = usePopupPosition(btn, open);
  const close = () => setOpen(false);
  useDismiss([btn, list], open, close);

  const current = p.options.find((o) => o.value === p.value);
  const toggle = () => {
    setActive(p.options.findIndex((o) => o.value === p.value));
    setOpen(!open);
  };
  const pick = (v: T) => {
    close();
    if (v !== p.value) p.onChange(v);
    btn.current?.focus();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select ${open ? "open" : ""} ${p.className ?? ""}`}
        title={p.title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          // 包在 <label> 里时，点标签文字也会触发一次 click，这里统一处理
          e.preventDefault();
          toggle();
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            toggle();
            return;
          }
          if (open) navKey(e, p.options.length, active, setActive, () => pick(p.options[active].value), close);
        }}
      >
        <span className="select-value">{current?.label ?? current?.value ?? p.value}</span>
        <span className="select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <OptionList listRef={list} style={style} options={p.options} selected={p.value} active={active} setActive={setActive} pick={pick} />
      )}
    </>
  );
}

/** 可以自由输入、也可以从建议里选的输入框（替代 input + datalist） */
export function Combo(p: {
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  onBlur?: (v: string) => void;
  placeholder?: string;
  title?: string;
  className?: string;
  /** 建议还在加载：箭头换成转圈，展开时显示这句提示 */
  loading?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  /** 刚打开时显示全部建议，开始打字后才按输入过滤 */
  const [typed, setTyped] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const style = usePopupPosition(wrap, open);
  const close = () => setOpen(false);
  useDismiss([wrap, list], open, close);

  const q = p.value.trim().toLowerCase();
  const shown = typed && q ? p.options.filter((o) => `${o.value} ${o.hint ?? ""}`.toLowerCase().includes(q)) : p.options;
  const pick = (v: string) => {
    p.onChange(v);
    close();
  };
  const show = () => {
    setTyped(false);
    setActive(-1);
    setOpen(true);
  };

  return (
    <div ref={wrap} className={`combo ${p.className ?? ""}`}>
      <input
        ref={input}
        value={p.value}
        placeholder={p.placeholder}
        title={p.title}
        onFocus={show}
        onClick={() => !open && show()}
        onChange={(e) => {
          p.onChange(e.target.value);
          setTyped(true);
          setActive(-1);
          setOpen(true);
        }}
        onBlur={(e) => {
          close();
          p.onBlur?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") return show();
          if (open) navKey(e, shown.length, active, setActive, () => pick(shown[active].value), close);
        }}
      />
      {p.loading && (
        <span className="combo-toggle combo-loading" title={p.loading}>
          <span className="spinner" aria-hidden="true" />
        </span>
      )}
      {!p.loading && p.options.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          className="combo-toggle"
          aria-label="展开建议"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            if (open) close();
            else {
              input.current?.focus();
              show();
            }
          }}
        >
          <span className="select-chevron" aria-hidden="true" />
        </button>
      )}
      {open && (shown.length > 0 || p.loading) && (
        <OptionList
          listRef={list}
          style={style}
          options={shown}
          selected={p.value}
          active={active}
          setActive={setActive}
          pick={pick}
          loading={p.loading}
        />
      )}
    </div>
  );
}
