import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { copyText } from "./copy";
import { kbd } from "./platform";

export type MenuItem = { label: string; hint?: string; onClick: () => void; danger?: boolean; disabled?: boolean } | "sep";

type Open = { x: number; y: number; items: MenuItem[] };
let show: ((m: Open | null) => void) | null = null;
/** 已由某个组件弹出菜单的那次原生事件：全局兜底就不再处理 */
let handled: Event | null = null;

/** 在鼠标处弹出右键菜单（各组件在 onContextMenu 里调用） */
export function openMenu(e: React.MouseEvent | MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  handled = "nativeEvent" in e ? e.nativeEvent : e;
  show?.({ x: e.clientX, y: e.clientY, items });
}

/** 当前选中的文字（不在 root 内就当没选） */
export function selectedText(root?: Element | null): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  if (root && !root.contains(sel.anchorNode)) return "";
  return sel.toString().trim();
}

/** 输入框的编辑菜单：用 execCommand 改内容，React 受控输入能收到 onChange，也进撤销栈 */
function editItems(el: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  const sel = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  const ro = el.readOnly || el.disabled;
  return [
    {
      label: "剪切",
      hint: kbd("Ctrl+X"),
      disabled: !sel || ro,
      onClick: () => {
        copyText(sel);
        el.focus();
        document.execCommand("delete");
      },
    },
    { label: "复制", hint: kbd("Ctrl+C"), disabled: !sel, onClick: () => copyText(sel) },
    {
      label: "粘贴",
      hint: kbd("Ctrl+V"),
      disabled: ro,
      onClick: async () => {
        const text = await readText().catch(() => "");
        el.focus();
        if (text) document.execCommand("insertText", false, text);
      },
    },
    "sep",
    { label: "全选", hint: kbd("Ctrl+A"), onClick: () => (el.focus(), el.select()) },
  ];
}

/**
 * 右键菜单宿主：屏蔽 WebView 自带的「返回 / 刷新 / 另存为」，组件没给菜单的地方兜底：
 * 输入框给编辑菜单，选中了文字给复制，其它空白处不弹。开发模式下 Shift+右键仍是原生菜单（有「检查元素」）。
 */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<Open | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    show = setMenu;
    const onMenu = (e: MouseEvent) => {
      if (import.meta.env.DEV && e.shiftKey) return;
      e.preventDefault();
      if (handled === e) return;
      const t = e.target as HTMLElement;
      const field = t.closest?.("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
      if (field && !t.closest(".xterm")) return setMenu({ x: e.clientX, y: e.clientY, items: editItems(field) });
      const text = selectedText();
      if (text) return setMenu({ x: e.clientX, y: e.clientY, items: [{ label: "复制", hint: kbd("Ctrl+C"), onClick: () => copyText(text) }] });
      setMenu(null);
    };
    window.addEventListener("contextmenu", onMenu);
    return () => {
      show = null;
      window.removeEventListener("contextmenu", onMenu);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    const blur = () => setMenu(null);
    document.addEventListener("mousedown", close, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
    };
  }, [menu]);

  // 先隐藏量尺寸，再放在鼠标右下；放不下就翻到左 / 上
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setStyle({ visibility: "hidden" });
    const m = ref.current.getBoundingClientRect();
    const left = menu.x + m.width > innerWidth - 8 ? Math.max(8, menu.x - m.width) : menu.x;
    const top = menu.y + m.height > innerHeight - 8 ? Math.max(8, menu.y - m.height) : menu.y;
    setStyle({ left, top });
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div ref={ref} className="menu popup-menu context-menu" role="menu" style={style}>
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}`}
            onClick={() => {
              if (it.disabled) return;
              setMenu(null);
              it.onClick();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd className="menu-kbd">{it.hint}</kbd>}
          </div>
        ),
      )}
    </div>,
    document.body,
  );
}
