import { useEffect, useRef, useState } from "react";

/** 应用内的确认/提示框，取代系统原生弹窗，风格和工具一致。用法同 plugin-dialog 的 ask / message */
type Kind = "info" | "warning" | "error";
interface Options {
  title?: string;
  kind?: Kind;
  /** 确认按钮文字，写清楚会发生什么（如「删除」） */
  okLabel?: string;
  /** 第三个选择（只有 choose 用），放在取消和确认之间 */
  altLabel?: string;
}
type Answer = boolean | "alt";
interface Request extends Options {
  text: string;
  confirm: boolean;
  resolve: (v: Answer) => void;
}

let push: ((r: Request) => void) | null = null;

function show(text: string, confirm: boolean, opts: Options = {}) {
  return new Promise<Answer>((resolve) => {
    if (push) push({ ...opts, text, confirm, resolve });
    else resolve(confirm ? window.confirm(text) : (window.alert(text), true));
  });
}

export const ask = (text: string, opts?: Omit<Options, "altLabel">) => show(text, true, opts).then((v) => v === true);
/** 三选一：确认 "ok"、第三个按钮 "alt"、取消或 Esc "cancel" */
export const choose = (text: string, opts: Options & { altLabel: string }) =>
  show(text, true, opts).then((v) => (v === "alt" ? "alt" : v ? "ok" : "cancel"));
export const message = (text: string, opts?: Options) => show(text, false, opts).then(() => undefined);

/** 挂在 App 根部；多个请求排队依次显示 */
export function ModalHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const okRef = useRef<HTMLButtonElement>(null);
  const cur = queue[0];

  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    return () => {
      push = null;
    };
  }, []);
  useEffect(() => okRef.current?.focus(), [cur]);
  if (!cur) return null;

  const close = (v: Answer) => {
    cur.resolve(v);
    setQueue((q) => q.slice(1));
  };
  const kind = cur.kind ?? "info";

  return (
    <div
      className="terminal-overlay modal-overlay"
      onKeyDown={(e) => {
        if (e.key === "Escape") close(false);
      }}
    >
      <div className={`dialog modal modal-${kind}`} role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 id="modal-title">
          <span className="modal-mark">{kind === "error" ? "✕" : kind === "warning" ? "!" : "◆"}</span>
          {kind === "error" ? (
            <span className="glitch" data-text={cur.title ?? "出错了"}>
              {cur.title ?? "出错了"}
            </span>
          ) : (
            cur.title ?? (cur.confirm ? "确认" : "提示")
          )}
        </h3>
        <div className="modal-text">{cur.text}</div>
        <div className="dialog-actions">
          {cur.confirm && <button onClick={() => close(false)}>取消</button>}
          {cur.confirm && cur.altLabel && <button onClick={() => close("alt")}>{cur.altLabel}</button>}
          <button
            ref={okRef}
            className={cur.confirm && kind === "warning" ? "danger" : "primary"}
            onClick={() => close(true)}
          >
            {cur.okLabel ?? (cur.confirm ? "确定" : "好的")}
          </button>
        </div>
      </div>
    </div>
  );
}
