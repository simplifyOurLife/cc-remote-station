import type { ITheme, Terminal } from "@xterm/xterm";

/**
 * 预测回显（类似 mosh / VS Code 远程终端的 typeahead）：高延迟下打字不等云端回显，先在本地画出来。
 *
 * 预测的字不写进 xterm 的缓冲区，而是画在盖在屏幕上的一层 DOM 里：献错了只是这层消失，
 * 永远不会弄脏真实屏幕。校验看「最终画面」而不是字节流：Claude Code 这类 TUI 回显时会重绘整个输入框，
 * 字节流里未必有那个字，但画完之后对应格子里一定是它。
 *
 * - 每个预测记住绝对行号（含滚动缓冲）和列；云端输出写完后对应格子变成预测的字就算确认，去掉覆盖层，
 *   下面的真字无缝接上；
 * - 超时没确认（密码输入等不回显的场景、或云端画了别的东西）就丢掉全部预测，并暂停到下一次回车；
 * - 只预测可打印字符；回车、方向键等控制键之后，等已有预测都结算完再重新开始；
 * - 延迟很低、全屏程序（vim 等，备用屏幕）、翻在历史里、光标隐藏时不预测。
 */

interface Prediction {
  /** 绝对行号（buffer 里的行，含滚动缓冲） */
  row: number;
  col: number;
  ch: string;
  /** 占几格：中文等全角字 2 格 */
  width: number;
  /** 预测时这个格子里原来的字：和预测的字相同时，要等云端光标越过它才算确认 */
  prev: string;
  at: number;
}

/** 往返低于这个就不必预测 */
const MIN_RTT = 30;
/** 至少采到几次往返再开始预测 */
const MIN_SAMPLES = 2;
const MAX_PENDING = 64;

export class TypeAhead {
  enabled = true;
  /** 按键到收到输出的往返（指数平滑），ms */
  rtt = 0;
  private samples = 0;
  private sampleFrom = 0;
  private preds: Prediction[] = [];
  /** 不回显或预测错了：暂停到下一次回车 */
  private paused = false;
  /** 按过控制键：等已有预测结算完、输出安静下来再预测 */
  private blocked = false;
  private blockedAt = 0;
  private layer: HTMLDivElement;
  private timer = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private term: Terminal,
    private theme: () => ITheme,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "ta-layer";
    term.element!.querySelector(".xterm-screen")!.appendChild(this.layer);
    const subs = [term.onScroll(() => this.render()), term.onResize(() => this.clear()), term.onRender(() => this.render())];
    this.disposers.push(() => subs.forEach((s) => s.dispose()));
  }

  dispose() {
    clearInterval(this.timer);
    this.disposers.forEach((d) => d());
    this.layer.remove();
  }

  /** 用户敲了键（已经发往云端） */
  onInput(data: string) {
    if (!this.sampleFrom) this.sampleFrom = performance.now();
    if (!this.enabled) return;
    if (data === "\r") {
      // 回车：新的一行重新试着预测（密码提示之后等）
      this.paused = false;
      this.block();
      return;
    }
    if (data === "\x7f" || data === "\b") {
      // 退格只撤掉还没确认的预测；已经是真字的等云端处理
      if (this.preds.pop()) this.render();
      else this.block();
      return;
    }
    const chars = printable(data);
    if (!chars) {
      this.block();
      return;
    }
    if (!this.canPredict()) return;
    const buf = this.term.buffer.active;
    const last = this.preds[this.preds.length - 1];
    let row = last ? last.row : buf.baseY + buf.cursorY;
    let col = last ? last.col + last.width : buf.cursorX;
    const now = performance.now();
    for (const ch of chars) {
      const width = charWidth(ch);
      // 不处理折行：到行尾就不再预测
      if (col + width >= this.term.cols || this.preds.length >= MAX_PENDING) break;
      this.preds.push({ row, col, ch, width, prev: cellAt(this.term, row, col), at: now });
      col += width;
    }
    this.ensureTimer();
    this.render();
  }

  /** 收到云端输出（写入 xterm 之前）：采一次往返 */
  onOutput() {
    if (!this.sampleFrom) return;
    const ms = performance.now() - this.sampleFrom;
    this.sampleFrom = 0;
    this.rtt = this.samples ? this.rtt * 0.7 + ms * 0.3 : ms;
    this.samples++;
  }

  /** 云端输出写进 xterm 之后：对照屏幕结算预测 */
  afterWrite = () => this.validate();

  clear() {
    if (!this.preds.length) return;
    this.preds = [];
    this.render();
  }

  private block() {
    this.blocked = true;
    this.blockedAt = performance.now();
  }

  private canPredict(): boolean {
    const buf = this.term.buffer.active;
    return (
      !this.paused &&
      !this.blocked &&
      this.samples >= MIN_SAMPLES &&
      this.rtt >= MIN_RTT &&
      buf.type === "normal" &&
      buf.viewportY === buf.baseY &&
      !cursorHidden(this.term)
    );
  }

  private timeout() {
    return Math.max(800, this.rtt * 3 + 300);
  }

  private validate() {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") {
      this.clear();
      this.blocked = false;
      return;
    }
    const now = performance.now();
    const curRow = buf.baseY + buf.cursorY;
    const curCol = buf.cursorX;
    const before = this.preds.length;
    const keep: Prediction[] = [];
    for (let i = 0; i < this.preds.length; i++) {
      const p = this.preds[i];
      const past = curRow > p.row || (curRow === p.row && curCol >= p.col + p.width);
      if (cellAt(this.term, p.row, p.col) === p.ch && (p.prev !== p.ch || past)) continue; // 已确认
      if (now - p.at > this.timeout()) {
        // 超时：后面的预测都建立在它之上，一起丢掉；大概率是不回显，暂停到回车
        keep.length = 0;
        this.paused = true;
        break;
      }
      keep.push(p);
    }
    this.preds = keep;
    // 控制键之后：预测都结算完、且控制键大概率已经到过云端并带回了输出，光标才是真实位置；
    // 只看「有输出」不够：别的输出（如动画）可能先到
    if (!keep.length && now - this.blockedAt >= this.rtt * 0.8) this.blocked = false;
    if (keep.length !== before) this.render();
    if (!keep.length) {
      clearInterval(this.timer);
      this.timer = 0;
    }
  }

  /** 云端一直不输出时也要按时结算超时 */
  private ensureTimer() {
    if (!this.timer) this.timer = window.setInterval(() => this.validate(), 150);
  }

  private render() {
    const layer = this.layer;
    if (!this.preds.length) {
      if (layer.firstChild) layer.replaceChildren();
      return;
    }
    const { w, h } = cellSize(this.term);
    const theme = this.theme();
    const buf = this.term.buffer.active;
    const font = `${this.term.options.fontSize}px ${this.term.options.fontFamily}`;
    const nodes: HTMLElement[] = [];
    for (const p of this.preds) {
      const y = p.row - buf.viewportY;
      if (y < 0 || y >= this.term.rows) continue;
      const el = document.createElement("span");
      el.className = "ta-char";
      el.textContent = p.ch;
      el.style.cssText = `left:${p.col * w}px;top:${y * h}px;width:${p.width * w}px;height:${h}px;line-height:${h}px;font:${font};color:${theme.foreground};background:${theme.background}`;
      nodes.push(el);
    }
    // 本地光标：真光标还停在云端的位置（被第一个预测字盖住），在预测末尾画一个
    const last = this.preds[this.preds.length - 1];
    const y = last.row - buf.viewportY;
    if (y >= 0 && y < this.term.rows) {
      const c = document.createElement("span");
      c.className = "ta-cursor";
      c.style.cssText = `left:${(last.col + last.width) * w}px;top:${y * h}px;width:${w}px;height:${h}px;background:${theme.cursor ?? theme.foreground}`;
      nodes.push(c);
    }
    layer.replaceChildren(...nodes);
  }
}

/** 全是可打印字符时返回逐字拆开的数组，否则 null（控制字符、转义序列、组合符、emoji 等宽度不确定的都不预测） */
function printable(data: string): string[] | null {
  const chars = Array.from(data);
  if (!chars.length || chars.length > 32) return null;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return null;
    // 组合符、零宽字符、变体选择符
    if ((c >= 0x300 && c < 0x370) || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f)) return null;
    // emoji 等：宽度在各终端不一致
    if (c >= 0x1f000 && c < 0x20000) return null;
  }
  return chars;
}

/** 终端里占几格：东亚全角字符 2 格，其余 1 格 */
function charWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  return (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
    ? 2
    : 1;
}

function cellAt(term: Terminal, row: number, col: number): string {
  return term.buffer.active.getLine(row)?.getCell(col)?.getChars() ?? "";
}

// 以下两个用到 xterm 内部字段（公开 API 没有），拿不到时退回保守做法

/** 一个字符格的 CSS 尺寸 */
function cellSize(term: Terminal): { w: number; h: number } {
  const cell = (term as any)._core?._renderService?.dimensions?.css?.cell;
  if (cell?.width && cell?.height) return { w: cell.width, h: cell.height };
  const rect = term.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
  return { w: rect.width / term.cols, h: rect.height / term.rows };
}

/** 程序把光标藏起来了（自己画光标的 TUI）：真光标不在输入位置，不能预测 */
function cursorHidden(term: Terminal): boolean {
  return Boolean((term as any)._core?.coreService?.isCursorHidden);
}
