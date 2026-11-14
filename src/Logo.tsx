/**
 * 品牌小机器人：和应用图标（src-tauri/app-icon.svg）、托盘图标是同一张 16px 像素图，这里去掉底板。
 * 眼睛（logo-eye）和天线灯（logo-antenna）单独成块，眨眼、扫视、闪烁等动效都挂在它们上
 */
export function Logo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`logo ${className}`} viewBox="0 -1 16 16" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      <rect className="logo-antenna" x="6" y="0" width="4" height="1" fill="#2de2ff" />
      <g fill="#ff3d9a">
        <rect x="7" y="1" width="2" height="1" />
        <rect x="2" y="2" width="12" height="9" />
        <rect x="0" y="5" width="2" height="3" />
        <rect x="14" y="5" width="2" height="3" />
        <rect x="3" y="11" width="2" height="3" />
        <rect x="6" y="11" width="2" height="3" />
        <rect x="9" y="11" width="2" height="3" />
        <rect x="12" y="11" width="2" height="3" />
      </g>
      <rect x="3" y="4" width="10" height="3" fill="#0a0817" />
      <rect className="logo-eye" x="4" y="5" width="3" height="1" fill="#2de2ff" />
      <rect className="logo-eye" x="9" y="5" width="3" height="1" fill="#2de2ff" />
      <rect x="4" y="8" width="3" height="1" fill="#ffc14d" />
    </svg>
  );
}
