import { useEffect, useState } from "react";
import { api, BUILTIN_CLOUD_NAME, BUILTIN_NAME, errorText, ImportCandidate, ToolboxItem, ToolSource } from "./api";
import { Loading } from "./Loading";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 来源的指纹：同一个 MCP 在多个配置里出现只列一次，工具箱里已有的不再导入 */
function sourceKey(s: ToolSource) {
  return JSON.stringify(s.kind === "stdio" ? [s.kind, s.command, s.args, s.env, s.cwd ?? null] : [s.kind, s.url, s.headers, s.legacySse]);
}

function describe(s: ToolSource) {
  return s.kind === "stdio" ? [s.command, ...s.args].join(" ") : s.url;
}

/** 配置里的名字可能含空格、点、中文，换成工具箱允许的字符 */
function cleanName(name: string) {
  return (
    name
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "mcp"
  );
}

interface Row {
  key: string;
  /** 出现在哪些配置里 */
  origins: string[];
  original: string;
  source: ToolSource;
  /** 工具箱里已经有一样的（显示它的名字） */
  existing: string | null;
  checked: boolean;
  name: string;
}

function buildRows(candidates: ImportCandidate[], items: ToolboxItem[]): Row[] {
  const existing = new Map(items.map((i) => [sourceKey(i), i.name]));
  const taken = new Set([BUILTIN_NAME, BUILTIN_CLOUD_NAME, ...items.map((i) => i.name)]);
  const rows: Row[] = [];
  for (const c of candidates) {
    if (!c.source) continue;
    const key = sourceKey(c.source);
    const same = rows.find((r) => r.key === key);
    if (same) {
      same.origins.push(c.origin);
      continue;
    }
    const have = existing.get(key) ?? null;
    let name = cleanName(c.name);
    if (!have) {
      // 重名就加序号：多个项目里都叫 filesystem 但配置不同时常见
      const base = name.slice(0, 29);
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      taken.add(name);
    }
    rows.push({ key, origins: [c.origin], original: c.name, source: c.source, existing: have, checked: !have, name });
  }
  return rows;
}

/** 从本机 Claude Code / Claude Desktop / Cursor 的配置里勾选 MCP，批量加进工具箱 */
export function ToolboxImport({
  items,
  builtinPort,
  onImport,
  onCancel,
}: {
  items: ToolboxItem[];
  builtinPort: number;
  onImport: (added: ToolboxItem[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [skipped, setSkipped] = useState<ImportCandidate[]>([]);
  const [showSkipped, setShowSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .toolboxImportScan()
      .then((list) => {
        setRows(buildRows(list, items));
        setSkipped(list.filter((c) => !c.source));
      })
      .catch((e) => {
        setRows([]);
        setError(errorText(e));
      });
  }, []);

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs && rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const chosen = rows?.filter((r) => r.checked && !r.existing) ?? [];

  const submit = async () => {
    const names = new Set([BUILTIN_NAME, BUILTIN_CLOUD_NAME, ...items.map((i) => i.name)]);
    for (const r of chosen) {
      const n = r.name.trim();
      if (!NAME_RE.test(n)) return setError(`「${r.original}」的名字只能用英文字母、数字、- 和 _，最多 32 个字符`);
      if (names.has(n)) return setError(`名字「${n}」重复了，请改一个`);
      names.add(n);
    }
    // 云端端口接着已用的最大端口往后排
    const used = new Set([builtinPort, ...items.map((i) => i.remotePort)]);
    let port = Math.max(...used, 47823);
    const added: ToolboxItem[] = chosen.map((r) => {
      do port++;
      while (used.has(port));
      return { ...r.source, name: r.name.trim(), enabled: true, remotePort: port, alias: "" };
    });
    setBusy(true);
    setError("");
    try {
      await onImport(added);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="terminal-overlay" onKeyDown={(e) => e.key === "Escape" && !busy && onCancel()}>
      <div className="dialog host-form toolbox-import">
        <h3>从本机导入 MCP</h3>
        <p className="muted">读取本机 Claude Code（全局和各项目）、Claude Desktop、Cursor 里已配的 MCP。只读取，不会改动这些配置。</p>

        {rows === null ? (
          <Loading text="扫描本机配置" />
        ) : rows.length === 0 ? (
          <p className="muted import-empty">没有找到可以导入的 MCP</p>
        ) : (
          <div className="import-list">
            {rows.map((r) => (
              <div key={r.key} className={`import-row ${r.existing ? "exists" : ""}`}>
                <input
                  type="checkbox"
                  aria-label={`导入 ${r.original}`}
                  checked={r.checked && !r.existing}
                  disabled={!!r.existing}
                  onChange={(e) => patch(r.key, { checked: e.target.checked })}
                />
                <div className="import-main">
                  <div className="import-head">
                    {r.existing ? (
                      <span className="tool-name">{r.existing}</span>
                    ) : (
                      <input
                        className="import-name"
                        value={r.name}
                        title="导入到工具箱里的名字"
                        onChange={(e) => patch(r.key, { name: e.target.value, checked: true })}
                      />
                    )}
                    <span className="toolbox-kind">
                      {r.source.kind === "stdio" ? "本机命令" : "HTTP 服务"}
                      {r.source.kind === "http" && r.source.legacySse && " · SSE"}
                    </span>
                    {r.existing && <span className="muted small">已在工具箱</span>}
                    {!r.existing && r.name !== r.original && <span className="muted small">原名 {r.original}</span>}
                  </div>
                  <code className="import-desc" title={describe(r.source)}>
                    {describe(r.source)}
                  </code>
                  <div className="muted small import-origin" title={r.origins.join("\n")}>
                    来自 {r.origins[0]}
                    {r.origins.length > 1 && ` 等 ${r.origins.length} 处`}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {skipped.length > 0 && (
          <div className="import-skipped">
            <button type="button" className="link" onClick={() => setShowSkipped(!showSkipped)}>
              {skipped.length} 个无法导入 {showSkipped ? "▴" : "▾"}
            </button>
            {showSkipped &&
              skipped.map((c, i) => (
                <div key={i} className="muted small">
                  {c.name}（{c.origin}）：{c.skipped}
                </div>
              ))}
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <span className="muted small grow">导入后自动分配云端端口，可再逐个编辑和测试</span>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || chosen.length === 0} onClick={submit}>
            {busy ? "导入中…" : `导入 ${chosen.length} 个`}
          </button>
        </div>
      </div>
    </div>
  );
}
