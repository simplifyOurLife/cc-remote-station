import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Item, itemText } from "./chatModel";

/**
 * 对话右侧的提问导航（类似 Codex）：每次提问一条等距短横线，正在看的那一轮加长高亮，
 * 这一轮里有搜索命中的横线变琥珀色。鼠标移上去展开所有提问的列表，点击跳过去。
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
  const asks = useMemo(() => {
    const hitSet = new Set(matches);
    const list: { key: string; idx: number; text: string; hit: boolean }[] = [];
    items.forEach((it, i) => {
      if (it.kind === "user") {
        list.push({ key: it.key, idx: i, text: itemText(it).replace(/\s+/g, " ").trim() || "[图片]", hit: false });
      }
      // 命中算在它所属的那一轮（最近的一次提问）上
      if (hitSet.has(it.key) && list.length) list[list.length - 1].hit = true;
    });
    return list;
  }, [items, matches]);

  /** 正在看的是第几轮：视口上部 1/3 处之前最后一次提问 */
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const el = scrollRef.current!;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = el.scrollTop + el.clientHeight / 3;
      let cur = -1;
      for (let i = 0; i < asks.length; i++) {
        if (asks[i].idx < shownFrom) {
          cur = i;
          continue;
        }
        const node = el.querySelector<HTMLElement>(`[data-key="${asks[i].key}"]`);
        if (!node || node.offsetTop > line) break;
        cur = i;
      }
      // 滚到底时算最后一轮（最后一轮很短时它的开头到不了 1/3 线）
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) cur = asks.length - 1;
      setActive(Math.max(0, cur));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [asks, shownFrom]);

  // 提问太多、横线放不下时，让当前这条保持在轨道中间
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    const dash = rail?.children[active] as HTMLElement | undefined;
    if (rail && dash) rail.scrollTop = dash.offsetTop - rail.offsetTop - rail.clientHeight / 2;
  }, [active, asks.length]);

  // 展开列表时把当前这一轮滚到可见处
  const listRef = useRef<HTMLDivElement>(null);
  const onEnter = () => {
    listRef.current?.querySelector<HTMLElement>(".outline-item.active")?.scrollIntoView({ block: "nearest" });
  };

  if (asks.length < 2) return null;
  return (
    <div className="chat-outline" onMouseEnter={onEnter}>
      <div className="outline-rail" ref={railRef}>
        {asks.map((a, i) => (
          <i key={a.key} className={`outline-dash${i === active ? " active" : ""}${a.hit ? " hit" : ""}`} />
        ))}
      </div>
      <div className="outline-panel" ref={listRef}>
        {asks.map((a, i) => (
          <button
            key={a.key}
            className={`outline-item${i === active ? " active" : ""}${a.hit ? " hit" : ""}`}
            title={a.text.length > 300 ? `${a.text.slice(0, 300)}…` : a.text}
            onClick={() => onJump(a.key)}
          >
            <span className="outline-no">{i + 1}</span>
            <span className="outline-text">{a.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
