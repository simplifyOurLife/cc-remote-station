import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { api, CmdError, errorText, Host, NeedSecret, TrustedKey } from "./api";
import { TerminalPrefs, themes } from "./prefs";
import { ConnectScreen } from "./ConnectScreen";

type Status =
  | { kind: "connecting" }
  | { kind: "hostKey"; key: TrustedKey }
  | { kind: "secret"; need: NeedSecret }
  | { kind: "connected" }
  | { kind: "error"; message: string }
  | { kind: "exited"; code: number }
  | { kind: "lost"; retryIn: number };

/** 断线重连的退避间隔（秒），用完后一直按最后一档重试 */
const RETRY_DELAYS = [1, 2, 5, 10, 30];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 父组件通过它往窗格里发文字（快捷命令）或拿焦点 */
export interface PaneControl {
  send: (text: string) => void;
  focus: () => void;
}

interface Props {
  host: Host;
  /** 窗格唯一键，开启 tmux 时用来生成稳定的远端会话名，重连时接回同一个会话 */
  paneKey: string;
  /** 接回已有 tmux 会话时指定会话名 */
  session?: string;
  /** 所在标签是否在前台 */
  visible: boolean;
  /** 是否是标签内当前窗格 */
  focused: boolean;
  prefs: TerminalPrefs;
  onTitle: (title: string) => void;
  /** 远端响铃 / 发通知且用户没在看这个窗格 */
  onAttention: () => void;
  onFocus: () => void;
  onSplit: (dir: "row" | "col") => void;
  onClose: () => void;
  onControl: (ctl: PaneControl | null) => void;
}

export function TerminalView(props: Props) {
  const { host, paneKey, visible, focused, prefs } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef<string | null>(null);
  // xterm 的回调只在初始化时注册一次，用 ref 读最新的 props
  const propsRef = useRef(props);
  propsRef.current = props;
  const retryRef = useRef({ count: 0, timer: 0 });
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const [trust, setTrust] = useState<TrustedKey | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(true);
  const [secretInput, setSecretInput] = useState("");
  const [search, setSearch] = useState<string | null>(null);
  const session = props.session ?? (host.tmux ? `ccws-${paneKey.slice(0, 8)}` : null);

  // xterm 实例跟随组件生命周期，重连时复用同一块屏幕
  useEffect(() => {
    const term = new Terminal({
      fontFamily: prefs.fontFamily,
      fontSize: prefs.fontSize,
      scrollback: prefs.scrollback,
      theme: themes[prefs.theme],
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri)));
    term.open(boxRef.current!);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL 不可用时退回 DOM 渲染
    }
    fit.fit();

    const send = (data: Uint8Array) => idRef.current && api.terminalWrite(idRef.current, data);

    // 剪贴板走 Tauri 插件，WebView 原生 copy/paste 在这里不可靠
    const copySelection = () => {
      const sel = term.getSelection();
      if (!sel) return false;
      // 去掉每行行尾填充空格，粘贴到编辑器里不脏
      writeText(sel.split("\n").map((l) => l.trimEnd()).join("\n"));
      term.clearSelection();
      return true;
    };
    // 优先粘文本；剪贴板里只有图片时传到远端，插入图片路径交给 Claude Code 读取
    const paste = async () => {
      const text = await readText().catch(() => "");
      if (text) return term.paste(text);
      const id = idRef.current;
      if (!id) return;
      try {
        const path = await api.terminalPasteImage(id);
        if (path) term.paste(path + " ");
      } catch (e) {
        term.write(`\r\n\x1b[31m[粘贴图片失败：${errorText(e)}]\x1b[0m\r\n`);
      }
    };
    // 强制重绘：缩一列再还原，远端收到两次 SIGWINCH 会整屏重画，清掉 TUI 残影
    const redraw = () => {
      const { cols, rows } = term;
      term.resize(Math.max(cols - 1, 2), rows);
      setTimeout(() => term.resize(cols, rows), 60);
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const key = e.key.toLowerCase();
      const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey;
      // Shift+Enter 发 LF：Claude Code 视为换行而不是提交；bash 里 LF 等同回车，无副作用
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        send(encoder.encode("\n"));
        return false;
      }
      // Ctrl+C：有选区就复制（同 Windows Terminal），否则照常发 ^C；Ctrl+Shift+C 始终复制
      if (e.ctrlKey && !e.altKey && key === "c" && (e.shiftKey || term.hasSelection())) {
        e.preventDefault();
        copySelection();
        return false;
      }
      // Ctrl+V / Ctrl+Shift+V 粘贴（term.paste 自带 bracketed paste）
      if (e.ctrlKey && !e.altKey && key === "v") {
        e.preventDefault();
        paste();
        return false;
      }
      // Ctrl+Shift+：R 重绘 / F 搜索 / D 向右分屏 / E 向下分屏 / W 关闭窗格
      const shortcuts: Record<string, () => void> = {
        r: redraw,
        f: () => setSearch((s) => s ?? ""),
        d: () => propsRef.current.onSplit("row"),
        e: () => propsRef.current.onSplit("col"),
        w: () => propsRef.current.onClose(),
      };
      if (ctrlShift && shortcuts[key]) {
        e.preventDefault();
        shortcuts[key]();
        return false;
      }
      return true;
    });
    // 右键：有选区复制，否则粘贴（PuTTY / Windows Terminal 习惯）
    boxRef.current!.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!copySelection()) paste();
    });
    term.textarea?.addEventListener("focus", () => propsRef.current.onFocus());

    // 通知：用户没在看这个窗格（窗口失焦、切到别的标签或窗格）时才打扰
    const notify = (body: string) => {
      const p = propsRef.current;
      if (document.hasFocus() && p.visible && p.focused) return;
      p.onAttention();
      api
        .notify(p.host.name, body)
        .catch((e) => term.write(`\r\n\x1b[31m[系统通知失败：${errorText(e)}]\x1b[0m\r\n`));
      getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
    };
    term.onBell(() => notify("终端响铃，可能在等你输入"));
    // OSC 9：iTerm2 风格通知（Claude Code preferredNotifChannel=iterm2 时使用）；9;4 是进度条，忽略
    term.parser.registerOscHandler(9, (data) => {
      if (!data.startsWith("4;")) notify(data);
      return true;
    });
    // OSC 777;notify;标题;正文（rxvt / Ghostty 风格）
    term.parser.registerOscHandler(777, (data) => {
      const [kind, title, body] = data.split(";");
      if (kind === "notify") notify(body ? `${title}：${body}` : title);
      return true;
    });
    // OSC 52：远端程序写本地剪贴板（Claude Code / tmux / vim 的复制）。只允许写，拒绝读取请求
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.slice(data.indexOf(";") + 1);
      if (b64 && b64 !== "?") {
        try {
          writeText(decoder.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
        } catch {
          // 非法 base64 直接忽略
        }
      }
      return true;
    });
    term.onTitleChange((t) => propsRef.current.onTitle(t));

    term.onData((s) => send(encoder.encode(s)));
    term.onBinary((s) => send(Uint8Array.from(s, (c) => c.charCodeAt(0))));
    term.onResize(({ cols, rows }) => idRef.current && api.terminalResize(idRef.current, cols, rows));

    const observer = new ResizeObserver(() => boxRef.current?.offsetParent && fit.fit());
    observer.observe(boxRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = searchAddon;
    propsRef.current.onControl({ send: (text) => send(encoder.encode(text)), focus: () => term.focus() });
    return () => {
      propsRef.current.onControl(null);
      observer.disconnect();
      clearTimeout(retryRef.current.timer);
      // 用户关窗格/标签：顺带结束远端 tmux 会话
      if (idRef.current) api.terminalClose(idRef.current, true);
      term.dispose();
    };
  }, []);

  // 终端设置变化时实时生效
  useEffect(() => {
    const term = termRef.current!;
    term.options.fontFamily = prefs.fontFamily;
    term.options.fontSize = prefs.fontSize;
    term.options.scrollback = prefs.scrollback;
    term.options.theme = themes[prefs.theme];
    fitRef.current?.fit();
  }, [prefs]);

  // 断线后按退避间隔自动重连
  const scheduleRetry = () => {
    const r = retryRef.current;
    const delay = RETRY_DELAYS[Math.min(r.count, RETRY_DELAYS.length - 1)];
    r.count++;
    setStatus({ kind: "lost", retryIn: delay });
    clearTimeout(r.timer);
    r.timer = window.setTimeout(() => setAttempt((n) => n + 1), delay * 1000);
  };

  useEffect(() => {
    const term = termRef.current!;
    let cancelled = false;
    setStatus({ kind: "connecting" });
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => term.write(new Uint8Array(buf));
    api
      .terminalOpen(host.id, term.cols, term.rows, { trust, secrets, remember, session }, channel)
      .then(({ id, notice }) => {
        if (cancelled) return api.terminalClose(id);
        idRef.current = id;
        if (notice) term.write(`\x1b[33m[${notice}]\x1b[0m\r\n`);
        retryRef.current.count = 0;
        setStatus({ kind: "connected" });
        if (propsRef.current.focused) term.focus();
      })
      .catch((e: CmdError) => {
        if (cancelled) return;
        if (e?.code === "hostKeyUnknown") setStatus({ kind: "hostKey", key: e });
        else if (e?.code === "needSecret") {
          setSecretInput("");
          setStatus({ kind: "secret", need: e });
        } else if (retryRef.current.count > 0) scheduleRetry(); // 自动重连中又失败：继续退避
        else setStatus({ kind: "error", message: errorText(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [host.id, attempt, trust, secrets]);

  useEffect(() => {
    const unlisten = listen<{ id: string; exitCode: number | null }>("terminal-exit", (e) => {
      if (e.payload.id !== idRef.current) return;
      idRef.current = null;
      const term = termRef.current!;
      if (e.payload.exitCode == null) {
        term.write("\r\n\x1b[33m[连接已断开，正在重连…]\x1b[0m\r\n");
        scheduleRetry();
      } else {
        setStatus({ kind: "exited", code: e.payload.exitCode });
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // 成为前台当前窗格时拿回焦点
  useEffect(() => {
    if (visible && focused) termRef.current?.focus();
  }, [visible, focused]);

  useEffect(() => {
    if (search !== null) searchInputRef.current?.focus();
  }, [search !== null]);

  const reconnectNow = () => {
    clearTimeout(retryRef.current.timer);
    setAttempt((n) => n + 1);
  };

  const submitSecret = (need: NeedSecret) => {
    if (!secretInput) return;
    setSecrets((s) => ({ ...s, [need.hostId]: secretInput }));
    setAttempt((n) => n + 1);
  };

  const closeSearch = () => {
    setSearch(null);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  return (
    <div className={`terminal-pane ${focused ? "focused" : ""}`} onMouseDown={props.onFocus}>
      <div ref={boxRef} className="terminal-box" />
      {search !== null && (
        <div className="search-bar">
          <input
            ref={searchInputRef}
            value={search}
            placeholder="搜索（Enter 下一个，Shift+Enter 上一个，Esc 关闭）"
            onChange={(e) => {
              setSearch(e.target.value);
              searchRef.current?.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              if (e.key === "Enter" && search) {
                if (e.shiftKey) searchRef.current?.findPrevious(search);
                else searchRef.current?.findNext(search);
              }
            }}
          />
          <button className="icon" onClick={closeSearch}>
            ×
          </button>
        </div>
      )}
      {status.kind === "connecting" && <ConnectScreen host={host} />}
      {status.kind === "lost" && (
        <div className="terminal-banner error">
          <span>连接已断开，{status.retryIn} 秒后自动重连</span>
          <button onClick={reconnectNow}>立即重连</button>
        </div>
      )}
      {status.kind === "hostKey" && (
        <div className="pane-overlay">
          <div className="dialog">
            <h3>首次连接这台主机</h3>
            <p>
              {status.key.host}:{status.key.port} 的主机密钥指纹：
            </p>
            <code className="fingerprint">{status.key.fingerprint}</code>
            <p className="muted">确认与服务器上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的输出一致后再信任。</p>
            <div className="dialog-actions">
              <button onClick={() => setStatus({ kind: "error", message: "已取消连接" })}>取消</button>
              <button className="primary" onClick={() => setTrust(status.key)}>
                信任并连接
              </button>
            </div>
          </div>
        </div>
      )}
      {status.kind === "secret" && (
        <div className="pane-overlay">
          <form
            className="dialog host-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitSecret(status.need);
            }}
          >
            <h3>
              {status.need.hostName} 的{status.need.kind === "password" ? "登录密码" : "私钥口令"}
            </h3>
            {status.need.wrong && <p className="form-error">刚才的{status.need.kind === "password" ? "密码" : "口令"}不正确，请重新输入</p>}
            <label>
              {status.need.kind === "password" ? "密码" : "口令"}：
              <input type="password" autoFocus value={secretInput} onChange={(e) => setSecretInput(e.target.value)} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              记住（保存到 Windows 凭据管理器）
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setStatus({ kind: "error", message: "已取消连接" })}>
                取消
              </button>
              <button type="submit" className="primary">
                连接
              </button>
            </div>
          </form>
        </div>
      )}
      {(status.kind === "error" || status.kind === "exited") && (
        <div className="terminal-banner error">
          <span>{status.kind === "error" ? status.message : `会话已结束（退出码 ${status.code}）`}</span>
          <button onClick={reconnectNow}>重新连接</button>
        </div>
      )}
    </div>
  );
}
