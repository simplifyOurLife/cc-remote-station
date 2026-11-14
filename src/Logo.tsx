/** 品牌小机器人，和 src-tauri/app-icon.svg 是同一张图（去掉了底板，放在导航栏里更轻） */
export function Logo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`logo ${className}`} viewBox="3 2 18 18" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      <g fill="#2de2ff" opacity="0.55">
        <rect x="6.5" y="6" width="12" height="9" />
        <rect x="18.5" y="9" width="2" height="3" />
      </g>
      <rect x="11" y="4" width="2" height="2" fill="#ff3d9a" />
      <rect className="logo-antenna" x="10" y="2.5" width="4" height="1.5" fill="#2de2ff" />
      <g fill="#ff3d9a">
        <rect x="6" y="6" width="12" height="9" />
        <rect x="4" y="9" width="2" height="3" />
        <rect x="18" y="9" width="2" height="3" />
        <rect x="7" y="15" width="1.5" height="3" />
        <rect x="9.5" y="15" width="1.5" height="3" />
        <rect x="13" y="15" width="1.5" height="3" />
        <rect x="15.5" y="15" width="1.5" height="3" />
      </g>
      <rect x="7" y="8" width="10" height="3.5" fill="#0a0817" />
      <rect className="logo-eye" x="8" y="9" width="2.5" height="1.5" fill="#2de2ff" />
      <rect className="logo-eye" x="13.5" y="9" width="2.5" height="1.5" fill="#2de2ff" />
      <rect x="8" y="12.5" width="1" height="1" fill="#0a0817" />
      <rect x="9.5" y="12.5" width="2.5" height="1" fill="#ffc14d" />
    </svg>
  );
}
