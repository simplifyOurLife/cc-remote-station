import { useState } from "react";
import { kbd } from "./platform";

/** 快捷键一览：尽量沿用 IDEA 的键位。单个 Ctrl+字母只在对话窗格里生效，终端里留给 shell */
const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "全局",
    items: [
      ["Ctrl+Shift+A / F1", "快捷键一览"],
      ["Ctrl+Alt+S", "设置"],
      ["Alt+→ / Alt+←", "下一个 / 上一个标签（输入框里不生效）"],
      ["Ctrl+Tab / Ctrl+Shift+Tab", "下一个 / 上一个标签（终端里也可用）"],
      ["Ctrl+F4", "关闭当前标签"],
      ["Alt+F12", "新建终端标签（当前主机）"],
      ["Ctrl+Alt+N", "新对话（对话窗格里换新会话，其它地方开新对话标签）"],
    ],
  },
  {
    title: "对话",
    items: [
      ["Ctrl+E", "最近会话快速打开"],
      ["Alt+1", "显示 / 收起左侧会话列表"],
      ["Ctrl+F", "搜索对话"],
      ["F3 / Shift+F3", "下一个 / 上一个搜索结果"],
      ["Ctrl+Alt+↑ / ↓", "上一个 / 下一个提问"],
      ["Ctrl+Home / Ctrl+End", "跳到对话开头 / 末尾（输入框外）"],
      ["Enter / Shift+Enter", "发送 / 换行"],
      ["Shift+Tab", "轮换权限模式"],
      ["Esc", "中断 Claude"],
    ],
  },
  {
    title: "终端",
    items: [
      ["Ctrl+Shift+D / E", "向右 / 向下分屏"],
      ["Ctrl+Shift+W", "关闭窗格"],
      ["Ctrl+Shift+F", "搜索终端输出"],
      ["Ctrl+Shift+R", "重绘"],
      ["Ctrl+C / Ctrl+V", "有选区时复制 / 粘贴"],
    ],
  },
];

export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const f = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter(([k, d]) => !f || `${k} ${d}`.toLowerCase().includes(f)) })).filter(
    (g) => g.items.length,
  );
  return (
    <div className="terminal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog shortcuts-panel">
        <h3>快捷键</h3>
        <input autoFocus value={q} placeholder="搜索快捷键或功能（Esc 关闭）" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
        <div className="shortcuts-list">
          {groups.map((g) => (
            <section key={g.title}>
              <div className="field-title">{g.title}</div>
              {g.items.map(([k, d]) => (
                <div key={k} className="shortcut-row">
                  <kbd>{kbd(k)}</kbd>
                  <span>{d}</span>
                </div>
              ))}
            </section>
          ))}
          {!groups.length && <p className="muted">没有匹配的快捷键</p>}
        </div>
      </div>
    </div>
  );
}
