import ReactDOM from "react-dom/client";
import App from "./App";

// 不用 StrictMode：开发态的双重 effect 会多建一条 SSH 会话
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
