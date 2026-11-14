import ReactDOM from "react-dom/client";
// 字体打包进应用，离线也能用：界面 Chakra Petch，终端与代码 JetBrains Mono
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import App from "./App";

// 不用 StrictMode：开发态的双重 effect 会多建一条 SSH 会话
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
