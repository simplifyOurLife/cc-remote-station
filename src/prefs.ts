import type { ITheme } from "@xterm/xterm";

export interface TerminalPrefs {
  fontFamily: string;
  fontSize: number;
  theme: "dark" | "light";
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
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontSize: 14,
    theme: "dark",
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
