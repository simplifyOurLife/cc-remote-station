import { useEffect } from "react";
import { createPortal } from "react-dom";

/** 全屏看大图：点任意处或按 Esc 关闭。挂到 body，免得被对话区的滚动和切角裁掉 */
export function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 别让 Esc 继续传到输入框，误中断正在回答的对话
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  return createPortal(
    <div className="image-viewer" onClick={onClose}>
      <img src={src} />
    </div>,
    document.body,
  );
}
