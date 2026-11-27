import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import { save } from "@tauri-apps/plugin-dialog";
import { api, errorText, FilePreviewData } from "./api";
import { copyText, hud } from "./copy";
import type { PreviewTarget } from "./fileLinks";
import { Markdown } from "./Markdown";
import { Diff } from "./ToolCard";

const WIDTH_KEY = "ccws.previewWidth";
/** 扩展名 → highlight.js 语言名（同名的不用列） */
const ALIAS: Record<string, string> = { tsx: "typescript", jsx: "javascript", mjs: "javascript", cjs: "javascript", vue: "xml", htm: "xml", kts: "kotlin" };
/** 超过这么大不高亮，免得卡住界面 */
const HIGHLIGHT_LIMIT = 300_000;

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const dirname = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const sizeText = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

function langOf(path: string) {
  const name = basename(path).toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : name;
  const lang = ALIAS[ext] ?? ext;
  return hljs.getLanguage(lang) ? lang : undefined;
}

/** 高亮后按行切开：多行注释、字符串的 span 会跨行，每行开头补上没闭合的标签、结尾补闭合 */
function highlightLines(text: string, lang: string | undefined): string[] {
  const html = lang && text.length < HIGHLIGHT_LIMIT ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : escapeHtml(text);
  const open: string[] = [];
  return html.split("\n").map((line) => {
    const prefix = open.join("");
    for (const m of line.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (m[0] === "</span>") open.pop();
      else open.push(m[0]);
    }
    return prefix + line + "</span>".repeat(open.length);
  });
}

/** 改动后的片段在文件里占哪几行（找不到的跳过） */
function editRanges(text: string, edits: NonNullable<PreviewTarget["edits"]>): [number, number][] {
  return edits.flatMap(({ newText }): [number, number][] => {
    const i = newText ? text.indexOf(newText) : -1;
    if (i < 0) return [];
    const start = text.slice(0, i).split("\n").length;
    return [[start, start + newText.split("\n").length - 1]];
  });
}

type Mode = "diff" | "render" | "code";

/** 对话右侧的文件预览抽屉：文件在云主机上，经 SSH 读前 1MB；只看不改 */
export function FilePreview({
  hostId,
  cwd,
  target,
  onClose,
  onOpenTerminal,
}: {
  hostId: string;
  /** 相对路径按它解析 */
  cwd: string;
  target: PreviewTarget;
  onClose: () => void;
  /** 新开终端标签，cd 到这个目录 */
  onOpenTerminal: (dir: string) => void;
}) {
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("code");
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 560);
  const codeRef = useRef<HTMLDivElement>(null);
  const isMd = /\.(md|markdown)$/i.test(target.path);
  const fullPath = data?.path ?? target.path;

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .filePreview(hostId, cwd, target.path)
      .then(setData, (e) => {
        setData(null);
        setError(errorText(e));
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    setData(null);
    load();
  }, [hostId, cwd, target.path]);
  useEffect(() => setMode(target.edits?.length ? "diff" : isMd && !target.line ? "render" : "code"), [target]);

  const lines = useMemo(() => (data?.text != null ? highlightLines(data.text, langOf(target.path)) : []), [data, target.path]);
  const ranges = useMemo<[number, number][]>(() => {
    if (target.line) return [[target.line, target.endLine ?? target.line]];
    return data?.text && target.edits ? editRanges(data.text, target.edits) : [];
  }, [data, target]);
  // 一整段 HTML 塞进去，比每行一个 React 节点快得多（文件可能上万行）
  const codeHtml = useMemo(
    () =>
      lines
        .map((l, i) => {
          const n = i + 1;
          const hit = ranges.some(([a, b]) => n >= a && n <= b);
          return `<div class="ln${hit ? " hit" : ""}" data-line="${n}"><span class="no">${n}</span><span>${l}</span></div>`;
        })
        .join(""),
    [lines, ranges],
  );

  // 滚到要看的行
  useLayoutEffect(() => {
    if (mode === "code" && ranges.length) codeRef.current?.querySelector(`[data-line="${ranges[0][0]}"]`)?.scrollIntoView({ block: "center" });
  }, [codeHtml, mode]);

  const download = async () => {
    if (!data) return;
    const dest = await save({ defaultPath: basename(data.path) });
    if (!dest) return;
    api.fileDownload(hostId, cwd, data.path, dest).then(
      () => hud(`> SAVED · ${dest}`),
      (e) => hud(`> 下载失败：${errorText(e)}`, false),
    );
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.max(300, Math.min(innerWidth * 0.8, w0 + x0 - ev.clientX));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const modes: [Mode, string][] = [
    ...(target.edits?.length ? ([["diff", "改动"]] as [Mode, string][]) : []),
    ...(isMd ? ([["render", "渲染"]] as [Mode, string][]) : []),
    ["code", isMd ? "源码" : "文件"],
  ];

  let body: React.ReactNode;
  if (mode === "diff" && target.edits) body = target.edits.map((e, i) => <Diff key={i} oldText={e.oldText} newText={e.newText} />);
  else if (error) body = <div className="form-error pad">{error}</div>;
  else if (!data) body = <div className="muted pad">读取中…</div>;
  else if (data.kind === "image") body = <img className="file-preview-image" src={data.image!} />;
  else if (data.kind === "binary")
    body = <div className="muted pad">{data.truncated && /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(data.path) ? "图片超过 10MB" : "二进制文件"}，不能预览，可以下载到本机查看</div>;
  else if (mode === "render")
    body = (
      <div className="file-preview-md">
        <Markdown text={data.text!} />
      </div>
    );
  else
    body = (
      <div
        ref={codeRef}
        className="file-preview-code hljs"
        style={{ "--digits": String(lines.length).length } as React.CSSProperties}
        dangerouslySetInnerHTML={{ __html: codeHtml }}
      />
    );

  return (
    <aside
      className="file-preview"
      style={{ width }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="file-preview-resize" title="拖动调整宽度" onPointerDown={startResize} />
      <div className="file-preview-head">
        <div className="file-preview-title">
          <b>{basename(fullPath)}</b>
          <span className="muted" title={fullPath}>
            {fullPath}
          </span>
        </div>
        <button className="icon" title="复制路径" onClick={() => copyText(fullPath, "路径")}>
          ⧉
        </button>
        <button className="icon" title="刷新" disabled={loading} onClick={load}>
          ⟳
        </button>
        <button className="icon" title="下载到本机" disabled={!data} onClick={download}>
          ⤓
        </button>
        <button className="icon" title="在新终端标签打开所在目录" disabled={!data} onClick={() => data && onOpenTerminal(dirname(data.path))}>
          ❯_
        </button>
        <button className="icon" title="关闭（Esc）" onClick={onClose}>
          ×
        </button>
      </div>
      {modes.length > 1 && (
        <div className="file-preview-modes">
          {modes.map(([m, label]) => (
            <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {data && (
        <div className="file-preview-meta muted">
          {sizeText(data.size)} · 修改于 {new Date(data.mtime * 1000).toLocaleString()}
          {data.truncated && data.kind === "text" && " · 文件较大，只显示前 1MB"}
        </div>
      )}
      <div className="file-preview-body">{body}</div>
    </aside>
  );
}
