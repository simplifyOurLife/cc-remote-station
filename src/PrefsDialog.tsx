import { useState } from "react";
import { Snippet, TerminalPrefs, UiPrefs } from "./prefs";

/** 终端外观与快捷命令，保存后立即作用到所有终端 */
export function PrefsDialog({
  prefs,
  onSave,
  onClose,
}: {
  prefs: UiPrefs;
  onSave: (p: UiPrefs) => void;
  onClose: () => void;
}) {
  const [term, setTerm] = useState<TerminalPrefs>(prefs.terminal);
  const [snippets, setSnippets] = useState<Snippet[]>(prefs.snippets);
  const patchTerm = (p: Partial<TerminalPrefs>) => setTerm((t) => ({ ...t, ...p }));
  const patchSnippet = (id: string, p: Partial<Snippet>) =>
    setSnippets((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));

  const save = () => {
    // 丢掉没填命令的空行
    onSave({ terminal: term, snippets: snippets.filter((s) => s.command.trim()) });
    onClose();
  };

  return (
    <div className="terminal-overlay">
      <div className="dialog host-form settings">
        <h3>终端与快捷命令</h3>

        <div className="field-title">外观：</div>
        <label>
          字体：
          <input value={term.fontFamily} onChange={(e) => patchTerm({ fontFamily: e.target.value })} />
        </label>
        <div className="row">
          <label className="grow">
            字号：
            <input
              type="number"
              min={9}
              max={32}
              value={term.fontSize}
              onChange={(e) => patchTerm({ fontSize: Number(e.target.value) || 14 })}
            />
          </label>
          <label className="grow">
            配色：
            <select value={term.theme} onChange={(e) => patchTerm({ theme: e.target.value as TerminalPrefs["theme"] })}>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
          <label className="grow">
            滚动缓冲行数：
            <input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={term.scrollback}
              onChange={(e) => patchTerm({ scrollback: Number(e.target.value) || 10000 })}
            />
          </label>
        </div>

        <div className="field-title">快捷命令（标签栏 ⚡ 里一键发送到当前终端）：</div>
        <div className="snippet-list">
          {snippets.map((s) => (
            <div key={s.id} className="row snippet-row">
              <input value={s.name} placeholder="名称" onChange={(e) => patchSnippet(s.id, { name: e.target.value })} />
              <input
                className="grow"
                value={s.command}
                placeholder="命令"
                onChange={(e) => patchSnippet(s.id, { command: e.target.value })}
              />
              <label className="checkbox" title="发送后自动回车执行">
                <input type="checkbox" checked={s.run} onChange={(e) => patchSnippet(s.id, { run: e.target.checked })} />
                回车
              </label>
              <button className="icon" title="删除" onClick={() => setSnippets((list) => list.filter((x) => x.id !== s.id))}>
                ×
              </button>
            </div>
          ))}
        </div>
        <button onClick={() => setSnippets((list) => [...list, { id: crypto.randomUUID(), name: "", command: "", run: true }])}>
          添加命令
        </button>

        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
