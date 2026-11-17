import { RefObject, useEffect, useState } from "react";
import { Item, itemText } from "./chatModel";

interface Mark {
  key: string;
  /** 在轨道上的位置，0–1 */
  pos: number;
  tip: string;
}

/**
 * 对话右侧的缩略导航轨：每次提问一条品红横线（悬停看开头、点击跳过去），搜索命中用琥珀刻度，
 * 青色框是当前可见范围。还没渲染的更早消息按条数均匀压在顶部一段，已渲染的按实际高度。
 */
export function ChatMinimap({
  scrollRef,
  items,
  shownFrom,
  matches,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  items: Item[];
  shownFrom: number;
  matches: string[];
  onJump: (key: string) => void;
}) {
  const [view, setView] = useState<{ asks: Mark[]; hits: Mark[]; top: number; height: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current!;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const total = el.scrollHeight;
      if (!items.length || total <= el.clientHeight + 4) return setView(null);
      // 未渲染部分占顶部的比例
      const f = shownFrom / items.length;
      const posOf = (key: string, idx: number) => {
        if (idx < shownFrom) return idx / items.length;
        const node = el.querySelector<HTMLElement>(`[data-key="${key}"]`);
        return node ? f + ((1 - f) * node.offsetTop) / total : null;
      };
      const index = new Map(items.map((it, i) => [it.key, i]));
      const asks: Mark[] = [];
      items.forEach((it, i) => {
        if (it.kind !== "user") return;
        const pos = posOf(it.key, i);
        const text = itemText(it).replace(/\s+/g, " ").trim() || "[图片]";
        if (pos !== null) asks.push({ key: it.key, pos, tip: text.length > 60 ? `${text.slice(0, 60)}…` : text });
      });
      const hits: Mark[] = [];
      for (const key of matches) {
        const pos = posOf(key, index.get(key) ?? 0);
        if (pos !== null) hits.push({ key, pos, tip: "" });
      }
      setView({ asks, hits, top: f + ((1 - f) * el.scrollTop) / total, height: ((1 - f) * el.clientHeight) / total });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      mo.disconnect();
    };
  }, [items, shownFrom, matches]);

  if (!view) return null;
  const pct = (p: number) => `${Math.min(100, Math.max(0, p * 100))}%`;
  return (
    <div className="chat-minimap">
      <div className="minimap-view" style={{ top: pct(view.top), height: pct(view.height) }} />
      {view.hits.map((m) => (
        <i key={`h${m.key}`} className="minimap-hit" style={{ top: pct(m.pos) }} />
      ))}
      {view.asks.map((m) => (
        <button key={m.key} className="minimap-ask" style={{ top: pct(m.pos) }} title={m.tip} onClick={() => onJump(m.key)} />
      ))}
    </div>
  );
}
