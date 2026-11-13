import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { openUrl } from "@tauri-apps/plugin-opener";
import "highlight.js/styles/github-dark.css";

/** 模型输出的 Markdown。必须经 DOMPurify 清洗：页面能调 Tauri IPC，不能让内容里的脚本跑起来 */
export function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })), [text]);

  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("pre code").forEach((el) => {
      if (!el.dataset.highlighted) hljs.highlightElement(el);
    });
  }, [html]);

  // 链接用系统浏览器打开，不在 WebView 里跳转
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (href && /^https?:\/\//.test(href)) openUrl(href);
  };

  return <div ref={ref} className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
