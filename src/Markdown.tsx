import { memo, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { openUrl } from "@tauri-apps/plugin-opener";
import "highlight.js/styles/github-dark.css";
import { FileLinkContext, parsePathRef } from "./fileLinks";

/** 一个顶层块（段落、列表、代码块…）。原文不变就不重渲染，流式输出时只有最后一块在变 */
const Block = memo(function Block({ raw }: { raw: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const links = useContext(FileLinkContext);
  // 必须经 DOMPurify 清洗：页面能调 Tauri IPC，不能让内容里的脚本跑起来
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(raw, { async: false, gfm: true, breaks: true })), [raw]);
  // 绘制前高亮，不会先闪一帧没上色的代码
  useLayoutEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("pre code").forEach((el) => hljs.highlightElement(el));
  }, [html]);
  // 像路径的行内代码：云主机上确认存在后才变成可点的链接
  useLayoutEffect(() => {
    if (!links) return;
    let alive = true;
    ref.current?.querySelectorAll<HTMLElement>(":not(pre) > code").forEach((el) => {
      const t = parsePathRef(el.textContent ?? "");
      if (!t) return;
      links.exists(t.path).then((ok) => {
        if (!ok || !alive) return;
        el.classList.add("file-link");
        el.title = "点击预览文件";
      });
    });
    return () => {
      alive = false;
    };
  }, [html, links]);
  return <div ref={ref} style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** 模型输出的 Markdown：按顶层块拆开渲染（display: contents，排版和整段渲染一致） */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => marked.lexer(text, { gfm: true, breaks: true }).map((t) => t.raw), [text]);
  const links = useContext(FileLinkContext);

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const code = target.closest("code.file-link");
    if (code && links) {
      const t = parsePathRef(code.textContent ?? "");
      if (t) links.open(t);
      return;
    }
    // 链接用系统浏览器打开，不在 WebView 里跳转
    const a = target.closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href && /^https?:\/\//.test(href)) openUrl(href);
  };

  return (
    <div className="markdown" onClick={onClick}>
      {blocks.map((raw, i) => (
        <Block key={i} raw={raw} />
      ))}
    </div>
  );
}
