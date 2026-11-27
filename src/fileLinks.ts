import { createContext } from "react";

/** 要在预览抽屉里打开的文件；line/endLine 是要高亮的行，edits 是 Edit 工具的改动（默认看改动） */
export interface PreviewTarget {
  path: string;
  line?: number;
  endLine?: number;
  edits?: { oldText: string; newText: string }[];
}

/** 对话窗格提供：打开预览、查路径是否存在（结果缓存、批量查询） */
export interface FileLinks {
  open: (t: PreviewTarget) => void;
  exists: (path: string) => Promise<boolean>;
}

export const FileLinkContext = createContext<FileLinks | null>(null);

const REF = /^(.+?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)?$/;

/** 行内代码像不像文件路径（可带 :行号、:起-止、#L行号）；像就返回路径和行号，最终要远端确认存在才可点 */
export function parsePathRef(raw: string): PreviewTarget | null {
  const s = raw.trim();
  if (!s || s.length > 300 || /\s|:\/\/|^[-$]|[<>|*?"'`(){}[\],;=]/.test(s)) return null;
  const m = REF.exec(s)!;
  const path = m[1];
  if (path.endsWith("/") || (!path.includes("/") && !/\.[A-Za-z]\w{0,7}$/.test(path))) return null;
  const line = Number(m[2] ?? m[4]) || undefined;
  return { path, line, endLine: Number(m[3] ?? m[5]) || line };
}
