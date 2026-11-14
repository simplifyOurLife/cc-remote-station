/** 终端字体候选：常见等宽字体，只列出本机装了的 */
export interface FontChoice {
  name: string;
  hint: string;
  /** 随应用打包，不用检测 */
  bundled?: boolean;
}

const CANDIDATES: FontChoice[] = [
  { name: "JetBrains Mono", hint: "内置，默认", bundled: true },
  { name: "Cascadia Code", hint: "Windows Terminal 默认，带连字" },
  { name: "Cascadia Mono", hint: "Windows Terminal 默认，无连字" },
  { name: "Consolas", hint: "Windows 自带" },
  { name: "Sarasa Mono SC", hint: "更纱黑体，中英文严格等宽" },
  { name: "Maple Mono NF CN", hint: "圆角，含中文和图标" },
  { name: "Maple Mono", hint: "圆角" },
  { name: "LXGW WenKai Mono", hint: "霞鹜文楷等宽" },
  { name: "Fira Code", hint: "带连字" },
  { name: "Source Code Pro", hint: "Adobe" },
  { name: "Hack", hint: "" },
  { name: "Iosevka", hint: "窄体，一屏放更多列" },
  { name: "MesloLGS NF", hint: "含 Powerline 图标" },
  { name: "CaskaydiaCove Nerd Font", hint: "含 Nerd Font 图标" },
  { name: "FiraCode Nerd Font", hint: "含 Nerd Font 图标" },
  { name: "Ubuntu Mono", hint: "" },
  { name: "Lucida Console", hint: "Windows 自带" },
  { name: "Courier New", hint: "Windows 自带，细" },
  { name: "NSimSun", hint: "新宋体，Windows 自带" },
];

/** 选中字体后面跟的兜底：缺字时依次回退，中文走雅黑 */
const FALLBACK = ['"JetBrains Mono"', "Consolas", '"Microsoft YaHei UI"', "monospace"];

/** 用 canvas 量宽度判断字体是否安装：和两种通用字体的宽度都一样，说明没生效 */
function installed(name: string, ctx: CanvasRenderingContext2D) {
  const sample = "mmmmmmmmmmlli10OQ中文";
  return ["monospace", "serif"].some((base) => {
    ctx.font = `72px ${base}`;
    const w0 = ctx.measureText(sample).width;
    ctx.font = `72px "${name}", ${base}`;
    return ctx.measureText(sample).width !== w0;
  });
}

let cache: FontChoice[] | null = null;
export function availableFonts(): FontChoice[] {
  if (cache) return cache;
  const ctx = document.createElement("canvas").getContext("2d");
  cache = ctx ? CANDIDATES.filter((f) => f.bundled || installed(f.name, ctx)) : CANDIDATES.filter((f) => f.bundled);
  return cache;
}

/** 字体列表里的第一个字体名 */
export function primaryFont(stack: string) {
  return stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

/** 选中的字体 + 兜底，去掉重复 */
export function fontStack(name: string) {
  const first = `"${name}"`;
  return [first, ...FALLBACK.filter((f) => f !== first && f !== name)].join(", ");
}
