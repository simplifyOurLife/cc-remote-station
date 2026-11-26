import ReactDOM from "react-dom/client";
// 字体打包进应用，离线也能用：界面 Chakra Petch，终端与代码 JetBrains Mono
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import App from "./App";
import { installTitleRedirect } from "./Tooltip";

// 在 React 第一次渲染前：title 一律改存 data-tip，不出系统白框提示
installTitleRedirect();

// 不用 StrictMode：开发态的双重 effect 会多建一条 SSH 会话
// 主按钮点击时扫过一道光带：重新挂上 class 让动画每次都从头播
const ZAP = "button.primary, button.danger";
document.addEventListener("click", (e) => {
  const b = (e.target as Element | null)?.closest?.(ZAP);
  if (!b) return;
  b.classList.remove("zap");
  void (b as HTMLElement).offsetWidth;
  b.classList.add("zap");
});
document.addEventListener("animationend", (e) => {
  if ((e as AnimationEvent).animationName === "btn-sweep") (e.target as Element).classList.remove("zap");
});

// 正式包里屏蔽 WebView 自带的浏览器快捷键：开发者工具、刷新（会丢掉所有会话状态）、打印、查看源码、页内查找。
// 只 preventDefault 不拦传播：终端里的 Ctrl+R（bash 反向搜索）等照常交给 xterm，只是浏览器不再响应。
// npm run tauri dev 时全部保留，方便调试
if (!import.meta.env.DEV) {
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (
      e.key === "F12" ||
      e.key === "F5" ||
      e.key === "F7" || // 插入符浏览
      (mod && e.shiftKey && (k === "i" || k === "j" || k === "c" || k === "r") && !(e.target as Element | null)?.closest?.(".xterm")) ||
      (mod && !e.shiftKey && (k === "r" || k === "p" || k === "u" || k === "f" || k === "g" || k === "s" || k === "j" || k === "h"))
    ) {
      e.preventDefault();
    }
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
