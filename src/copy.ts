import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** 最近一次按下鼠标的位置和按到的按钮：回执飘在这里，按钮闪一下 */
let last = { x: innerWidth / 2, y: innerHeight / 2, button: null as HTMLElement | null };
document.addEventListener(
  "pointerdown",
  (e) => {
    last = { x: e.clientX, y: e.clientY, button: (e.target as Element | null)?.closest?.("button") ?? null };
  },
  true,
);

/** 在鼠标处飘一行终端风回执（上飘淡出后自己移除） */
export function hud(text: string, ok = true) {
  const el = document.createElement("div");
  el.className = `hud-receipt ${ok ? "ok" : "fail"}`;
  el.textContent = text;
  document.body.appendChild(el);
  // 默认在鼠标右上方，靠近窗口边缘就往里收
  const w = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(last.x + 12, innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, last.y - 30)}px`;
  el.addEventListener("animationend", () => el.remove());
  const b = last.button;
  if (b?.isConnected) {
    b.classList.remove("copy-flash", "copy-flash-fail");
    void b.offsetWidth;
    b.classList.add(ok ? "copy-flash" : "copy-flash-fail");
    setTimeout(() => b.classList.remove("copy-flash", "copy-flash-fail"), 500);
  }
}

/** 复制并在鼠标处飘出回执（复制了多少字，或传入的 what）；失败飘红色 */
export async function copyText(text: string, what?: string): Promise<boolean> {
  try {
    await writeText(text);
  } catch {
    hud("> COPY FAILED ✕", false);
    return false;
  }
  hud(`> COPIED · ${what ?? `${text.length} 字`}`);
  return true;
}
