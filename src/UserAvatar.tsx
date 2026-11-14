/**
 * 用户头像：像素风的兜帽黑客，和小机器人同一套配色（品红兜帽、深色脸、青色面罩、琥珀点缀）。
 * 面罩用 logo-eye，和机器人眼睛一样偶尔眨一下
 */
export function UserAvatar({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`user-avatar ${className}`} viewBox="1 0 14 15" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      {/* 青色错位影，和机器人的故障偏移呼应 */}
      <g fill="#2de2ff" opacity="0.5">
        <rect x="3.5" y="10" width="11" height="4" />
        <rect x="11.5" y="3" width="2" height="4" />
      </g>
      {/* 兜帽 */}
      <g fill="#ff3d9a">
        <rect x="5" y="1" width="6" height="1" />
        <rect x="4" y="2" width="8" height="1" />
        <rect x="3" y="3" width="2" height="4" />
        <rect x="11" y="3" width="2" height="4" />
        <rect x="4" y="7" width="2" height="1" />
        <rect x="10" y="7" width="2" height="1" />
        {/* 肩膀 */}
        <rect x="3" y="9" width="10" height="1" />
        <rect x="2" y="10" width="12" height="4" />
      </g>
      {/* 脸和脖子 */}
      <g fill="#0a0817">
        <rect x="5" y="3" width="6" height="4" />
        <rect x="6" y="7" width="4" height="1" />
        <rect x="6" y="8" width="4" height="2" />
      </g>
      {/* 面罩 */}
      <rect className="logo-eye" x="6" y="4" width="4" height="1.2" fill="#2de2ff" />
      {/* 胸前琥珀条 */}
      <rect x="4" y="12" width="3" height="1" fill="#ffc14d" />
    </svg>
  );
}
