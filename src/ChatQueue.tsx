import { useRef, useState } from "react";

export type Queued = { id: number; text: string; images: string[] };

let seq = 0;
export const queued = (text: string, images: string[]): Queued => ({ id: ++seq, text, images });

/** 候补消息：本轮回答结束后按顺序逐条发出；可拖动/上下移调整顺序、编辑、删除、插队立即发 */
export function ChatQueue(p: {
  items: Queued[];
  paused: boolean;
  onChange: (items: Queued[]) => void;
  onEditing: (id: number | null) => void;
  onSendNow: (id: number) => void;
  onResume: () => void;
}) {
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= p.items.length || to === from) return;
    const next = [...p.items];
    next.splice(to, 0, next.splice(from, 1)[0]);
    p.onChange(next);
  };

  const edit = (q: Queued | null) => {
    setEditing(q && { id: q.id, text: q.text });
    p.onEditing(q?.id ?? null);
  };

  const save = () => {
    if (!editing) return;
    const text = editing.text;
    const q = p.items.find((x) => x.id === editing.id);
    // 改成空且没有图片就等于删除
    if (q) p.onChange(text.trim() || q.images.length ? p.items.map((x) => (x.id === q.id ? { ...x, text } : x)) : p.items.filter((x) => x !== q));
    edit(null);
  };

  /** 按住左侧把手拖动：指针经过哪一行就换到哪一行的位置 */
  const onDragMove = (e: React.PointerEvent) => {
    if (drag === null) return;
    const rows = [...(listRef.current?.children ?? [])] as HTMLElement[];
    const to = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY < b.bottom;
    });
    const from = p.items.findIndex((x) => x.id === drag);
    if (to >= 0 && from >= 0) move(from, to);
  };

  return (
    <div className="chat-queue">
      <div className="chat-queue-head">
        <span className="chat-queue-tag">QUEUE</span>
        <span>
          {p.items.length} 条候补消息{p.paused ? "，已中断，暂停发送" : "，本轮回答结束后依次发送"}
        </span>
        {p.paused && (
          <button className="link" onClick={p.onResume}>
            继续发送
          </button>
        )}
        <button className="link" onClick={() => p.onChange([])}>
          全部清空
        </button>
      </div>
      <div className="chat-queue-list" ref={listRef}>
        {p.items.map((q, i) => (
          <div key={q.id} className={`chat-queue-item${drag === q.id ? " dragging" : ""}`}>
            <span
              className="chat-queue-grip"
              title="按住拖动调整顺序"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDrag(q.id);
              }}
              onPointerMove={onDragMove}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            {editing?.id === q.id ? (
              <textarea
                autoFocus
                rows={Math.min(6, editing.text.split("\n").length + 1)}
                value={editing.text}
                onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                onBlur={save}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    save();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    edit(null);
                  }
                }}
              />
            ) : (
              <div className="chat-queue-text" title="双击编辑" onDoubleClick={() => edit(q)}>
                {q.text || <span className="muted">（仅图片）</span>}
                {q.images.length > 0 && <span className="chat-queue-img">🖼 {q.images.length}</span>}
              </div>
            )}
            <div className="chat-queue-ops">
              <button className="icon" title="上移" disabled={i === 0} onClick={() => move(i, i - 1)}>
                ↑
              </button>
              <button className="icon" title="下移" disabled={i === p.items.length - 1} onClick={() => move(i, i + 1)}>
                ↓
              </button>
              <button className="icon" title="编辑（Enter 保存，Esc 取消）" onClick={() => edit(q)}>
                ✎
              </button>
              <button className="icon" title="中断当前回答，立即发送这条" onClick={() => p.onSendNow(q.id)}>
                ⚡
              </button>
              <button className="icon danger" title="删除" onClick={() => p.onChange(p.items.filter((x) => x !== q))}>
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
