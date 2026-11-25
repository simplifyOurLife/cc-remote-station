import { useMemo, useState } from "react";
import { availableFonts, fontStack, primaryFont } from "./fonts";
import { Snippet, TerminalPrefs, themes, UiPrefs } from "./prefs";
import { NumberInput } from "./NumberInput";
import { SaveButton } from "./SaveButton";
import { Select } from "./Select";

const CUSTOM = "__custom__";

/** 终端外观与快捷命令，保存后立即作用到所有终端 */
export function PrefsPanel({ prefs, onSave }: { prefs: UiPrefs; onSave: (p: UiPrefs) => void }) {
  const [term, setTerm] = useState<TerminalPrefs>(prefs.terminal);
  const [snippets, setSnippets] = useState<Snippet[]>(prefs.snippets);
  const fonts = useMemo(availableFonts, []);
  const primary = primaryFont(term.fontFamily);
  // 当前字体不在列表里（手填过或已卸载）就停在自定义
  const [customFont, setCustomFont] = useState(() => !fonts.some((f) => f.name === primary));
  const patchTerm = (p: Partial<TerminalPrefs>) => {
    setTerm((t) => ({ ...t, ...p }));
  };
  const patchSnippet = (id: string, p: Partial<Snippet>) => {
    setSnippets((list) => list.map((s) => (s.id === id ? { ...s, ...p } : s)));
  };
  /** 调整顺序（⚡ 菜单按这个顺序列出） */
  const moveSnippet = (from: number, to: number) => {
    setSnippets((list) => {
      const next = [...list];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  };

  const save = () => {
    // 丢掉没填命令的空行
    const clean = snippets.filter((s) => s.command.trim());
    setSnippets(clean);
    onSave({ terminal: term, snippets: clean });
  };

  return (
    <>
      <section className="page-card host-form">
        <h3>终端外观</h3>
        <label>
          字体：
          <Select
            value={customFont ? CUSTOM : primary}
            onChange={(v) => {
              if (v === CUSTOM) setCustomFont(true);
              else {
                setCustomFont(false);
                patchTerm({ fontFamily: fontStack(v) });
              }
            }}
            options={[
              ...fonts.map((f) => ({
                value: f.name,
                label: <span style={{ fontFamily: fontStack(f.name) }}>{f.name}</span>,
                hint: f.hint,
              })),
              { value: CUSTOM, label: "自定义…", hint: "手动填写 CSS 字体列表" },
            ]}
          />
        </label>
        {customFont && (
          <label>
            自定义字体列表：
            <input value={term.fontFamily} onChange={(e) => patchTerm({ fontFamily: e.target.value })} />
            <span className="muted small">逗号分隔，前面的优先；含空格的字体名加引号，如 "Fira Code", Consolas, monospace</span>
          </label>
        )}
        <div className="row">
          <label className="grow">
            字号：
            <NumberInput min={9} max={32} value={term.fontSize} onChange={(n) => patchTerm({ fontSize: n || 14 })} />
          </label>
          <label className="grow">
            配色：
            <Select
              value={term.theme}
              onChange={(theme) => patchTerm({ theme })}
              options={[
                { value: "neon", label: "霓虹" },
                { value: "dark", label: "深色" },
                { value: "light", label: "浅色" },
              ]}
            />
          </label>
          <label className="grow">
            滚动缓冲行数：
            <NumberInput
              min={1000}
              max={100000}
              step={1000}
              value={term.scrollback}
              onChange={(n) => patchTerm({ scrollback: n || 10000 })}
            />
          </label>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={term.predictiveEcho} onChange={(e) => patchTerm({ predictiveEcho: e.target.checked })} />
          预测回显
          <span className="muted small">
            网络延迟高时，打的字先在本地显示、云端回显后自动校正（延迟低于 30ms、vim 等全屏程序、密码输入时自动不预测）
          </span>
        </label>
        <div className="field-title">预览：</div>
        <pre
          className="font-preview"
          style={{
            fontFamily: term.fontFamily,
            fontSize: term.fontSize,
            background: themes[term.theme].background,
            color: themes[term.theme].foreground,
          }}
        >
          <span style={{ color: themes[term.theme].green }}>ubuntu@cloud</span>:<span style={{ color: themes[term.theme].blue }}>~/project</span>$ claude
          {"\n"}✓ 已修改 src/main.rs，测试全部通过
          {"\n"}0O 1lI {"{} [] => != <="} — 中英文混排是否对齐
        </pre>
      </section>

      <section className="page-card host-form">
        <h3>快捷命令</h3>
        <p className="muted">在工作区标签栏的 ⚡ 里一键发送到当前终端。</p>
        <div className="snippet-list">
          {snippets.map((s, i) => (
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
              <button className="icon" title="上移" disabled={i === 0} onClick={() => moveSnippet(i, i - 1)}>
                ↑
              </button>
              <button className="icon" title="下移" disabled={i === snippets.length - 1} onClick={() => moveSnippet(i, i + 1)}>
                ↓
              </button>
              <button
                className="icon"
                title="删除"
                onClick={() => {
                  setSnippets((list) => list.filter((x) => x.id !== s.id));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button onClick={() => setSnippets((list) => [...list, { id: crypto.randomUUID(), name: "", command: "", run: true }])}>
          添加命令
        </button>
      </section>

      <div className="page-actions">
        <SaveButton onSave={save} savedText="已作用到所有终端 ✓" receipt="PREFS APPLIED">
          保存设置
        </SaveButton>
      </div>
    </>
  );
}
