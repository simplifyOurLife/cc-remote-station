import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { openUrl } from "@tauri-apps/plugin-opener";
import "highlight.js/styles/github-dark.css";

/** 一个顶层块（段落、列表、代码块…）。原文不变就不重渲染，流式输出时只有最后一块在变 */
const Block = memo(function Block({ raw }: { raw: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // 必须经 DOMPurify 清洗：页面能调 Tauri IPC，不能让内容里的脚本跑起来
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(raw, { async: false, gfm: true, breaks: true })), [raw]);
  // 绘制前高亮，不会先闪一帧没上色的代码
  useLayoutEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("pre code").forEach((el) => hljs.highlightElement(el));
  }, [html]);
  return <div ref={ref} style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />;
});

/** 模型输出的 Markdown：按顶层块拆开渲染（display: contents，排版和整段渲染一致） */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => marked.lexer(text, { gfm: true, breaks: true }).map((t) => t.raw), [text]);

  // 链接用系统浏览器打开，不在 WebView 里跳转
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
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
