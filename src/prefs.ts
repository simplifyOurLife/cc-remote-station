import type { ITheme } from "@xterm/xterm";

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  theme: "neon" | "dark" | "light";
  scrollback: number;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  /** 发送后自动回车执行 */
  run: boolean;
}

/** 存在 ui.json 的界面偏好 */
export interface UiPrefs {
  terminal: TerminalPrefs;
  snippets: Snippet[];
}

export const defaultPrefs: UiPrefs = {
  terminal: {
    fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, Menlo, "SF Mono", "Microsoft YaHei UI", "PingFang SC", monospace',
    fontSize: 14,
    theme: "neon",
    scrollback: 10000,
  },
  snippets: [
    { id: "claude", name: "启动 Claude Code", command: "claude", run: true },
    { id: "claude-continue", name: "继续上次对话", command: "claude --continue", run: true },
    { id: "claude-resume", name: "选择历史对话", command: "claude --resume", run: true },
  ],
};

/** ui.json 可能缺字段（早期版本或手改），逐项补齐默认值 */
export function mergePrefs(raw: Record<string, unknown>): UiPrefs {
  const r = raw as Partial<UiPrefs>;
  return {
    terminal: { ...defaultPrefs.terminal, ...(r.terminal ?? {}) },
    snippets: r.snippets ?? defaultPrefs.snippets,
  };
}

export const themes: Record<TerminalPrefs["theme"], ITheme> = {
  // 与界面同一套夜间配色：紫黑底、青电光标、洋红选区，ANSI 色调成霓虹但保证在深底上可读
  neon: {
    background: "#0a0817",
    foreground: "#e6e3ff",
    cursor: "#2de2ff",
    cursorAccent: "#0a0817",
    selectionBackground: "#ff3d9a55",
    black: "#1b1736",
    red: "#ff5470",
    green: "#5cf2b0",
    yellow: "#ffc14d",
    blue: "#6e8bff",
    magenta: "#ff3d9a",
    cyan: "#2de2ff",
    white: "#c9c4f0",
    brightBlack: "#5a5390",
    brightRed: "#ff8095",
    brightGreen: "#8affcb",
    brightYellow: "#ffd88a",
    brightBlue: "#9aafff",
    brightMagenta: "#ff7ab8",
    brightCyan: "#8cf0ff",
    brightWhite: "#ffffff",
  },
  dark: {
    background: "#14161b",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selectionBackground: "#3b4252",
  },
  // 浅色下重新调 ANSI 色：默认黄/青在白底上几乎看不清
  light: {
    background: "#fafafa",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "#b6d6fd",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#7d4e00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};
