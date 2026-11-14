import { ReactNode, useEffect, useState } from "react";
import { Host } from "./api";
import { Loading } from "./Loading";
import { Logo } from "./Logo";

/**
 * 连接/启动中的整窗格画面：网格底 + 下扫的扫描线 + 故障效果的主机名 + 逐格加载条 + 已用时间。
 * 终端用默认文案；对话传 robot，左侧加上全息环绕的小机器人
 */
export function ConnectScreen({
  host,
  label = "正在接入",
  detail,
  progress = "建立 SSH 加密通道",
  robot = false,
}: {
  host: Host;
  label?: string;
  /** 主机名下面一行；默认 user@host:port */
  detail?: ReactNode;
  progress?: string;
  robot?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const timer = setInterval(() => setElapsed(performance.now() - start), 100);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="connect-screen" role="status" aria-label={`${label} ${host.name}`}>
      <div className="connect-sweep" aria-hidden="true" />
      <div className={`connect-card ${robot ? "with-robot" : ""}`}>
        {robot && (
          <div className="boot-robot" aria-hidden="true">
            <span className="boot-ring outer" />
            <span className="boot-ring inner" />
            <span className="boot-float">
              <Logo size={84} className="logo-boot" />
            </span>
            <span className="boot-beam" />
            <span className="boot-shadow" />
          </div>
        )}
        <div className="connect-info">
          <div className="connect-label">{label}</div>
          <div className="connect-host glitch" data-text={host.name}>
            {host.name}
          </div>
          <div className="connect-addr">
            {detail ?? (
              <>
                {host.user}@{host.host}:{host.port}
                {host.jump && <span className="muted"> · 经跳板机</span>}
              </>
            )}
          </div>
          <div className="connect-progress">
            <Loading text={progress} />
            <span className="connect-timer">{(elapsed / 1000).toFixed(1)}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
