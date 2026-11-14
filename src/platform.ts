/** 平台差异：macOS 上快捷键用 ⌘、窗口按钮用系统红黄绿灯、凭据存在钥匙串 */
export const isMac = /Mac/i.test(navigator.userAgent);

/** 快捷键的「主修饰键」：macOS 是 ⌘，其他是 Ctrl */
export const modKey = (e: { ctrlKey: boolean; metaKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey);

/** 把写成 Windows 风格的快捷键文字换成当前平台的写法：Ctrl+Shift+D → ⇧⌘D */
export function kbd(text: string) {
  if (!isMac) return text;
  return text.replace(/Ctrl\+Shift\+(\w)/g, "⇧⌘$1").replace(/Ctrl\+(\w)/g, "⌘$1").replace(/Alt\+/g, "⌥");
}

/** 系统保存密码的地方 */
export const keychainName = isMac ? "钥匙串" : "Windows 凭据管理器";
