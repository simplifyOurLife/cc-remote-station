import { useEffect, useState } from "react";
import { api, BUILTIN_NAME, Host, HostTool, hostTools, McpHostStatus, Settings, toolLabel, ToolboxItem } from "./api";
import { NumberInput } from "./NumberInput";

let portPromise: Promise<number> | null = null;

/** 内置服务的本机端口（启动后不变，只取一次）；内置工具和本机命令类工具都转发到这里 */
export function useLocalPort() {
  const [port, setPort] = useState<number | null>(null);
  useEffect(() => {
    (portPromise ??= api.mcpLocalPort()).then(setPort).catch(() => {});
  }, []);
  return port;
}

/** 转发表里的一行：工具箱里的一个工具在这台主机上转不转发、用哪个云端端口 */
export interface ToolRow {
  name: string;
  on: boolean;
  port: number;
}

interface ToolInfo {
  name: string;
  /** 工具箱里的条目；内置工具为 null */
  item: ToolboxItem | null;
  defaultPort: number;
}

/** 内置工具 + 工具箱里的所有条目，带各自的默认映射端口 */
function toolInfos(s: Settings): ToolInfo[] {
  return [
    { name: BUILTIN_NAME, item: null, defaultPort: s.remotePort },
    ...s.toolbox.map((item) => ({ name: item.name, item, defaultPort: item.remotePort })),
  ];
}

/** 把主机保存的工具展开成表格行：没改过的显示默认端口 */
export function initRows(host: Host, s: Settings): ToolRow[] {
  const saved = new Map(hostTools(host).map((t) => [t.name, t]));
  return toolInfos(s).map((info) => {
    const t = saved.get(info.name);
    return { name: info.name, on: !!t, port: t?.remotePort ?? info.defaultPort };
  });
}

/** 表格行 → 主机保存的工具：和默认端口一样的不存，工具箱里的默认值以后变了还能跟着变 */
export function rowsToTools(rows: ToolRow[], s: Settings): HostTool[] {
  const infos = new Map(toolInfos(s).map((i) => [i.name, i]));
  return rows.filter((r) => r.on).map((r) => ({ name: r.name, remotePort: r.port === infos.get(r.name)!.defaultPort ? null : r.port }));
}

/** 启用的行里端口不合法或重复的，返回行名 → 问题 */
export function rowProblems(rows: ToolRow[]): Map<string, string> {
  const problems = new Map<string, string>();
  const on = rows.filter((r) => r.on);
  for (const r of on) {
    if (!(r.port >= 1024 && r.port <= 65535)) problems.set(r.name, "端口要在 1024–65535 之间");
    else if (on.some((o) => o !== r && o.port === r.port)) problems.set(r.name, `端口 ${r.port} 重复`);
  }
  return problems;
}

/** 本机一侧的真实地址：内置工具和本机命令都由内置服务接收，HTTP 工具是它自己的地址 */
function localSide(info: ToolInfo, port: number | null) {
  if (!info.item || info.item.kind === "stdio") return port ? `127.0.0.1:${port}` : "…";
  try {
    return new URL(info.item.url).host;
  } catch {
    return info.item.url;
  }
}

/** 主机的端口转发表：每行一个工具，可启用、改这台主机上的云端端口 */
export function HostToolsTable({
  rows,
  onChange,
  settings,
  status,
}: {
  rows: ToolRow[];
  onChange: (rows: ToolRow[]) => void;
  settings: Settings;
  /** 这台主机当前连接上的转发；未连接为 undefined */
  status?: McpHostStatus;
}) {
  const infos = new Map(toolInfos(settings).map((i) => [i.name, i]));
  const problems = rowProblems(rows);
  const port = useLocalPort();
  const set = (name: string, patch: Partial<ToolRow>) => onChange(rows.map((r) => (r.name === name ? { ...r, ...patch } : r)));

  return (
    <div className="host-tools-table-wrap">
      <table className="host-tools-table">
        <thead>
          <tr>
            <th className="col-on">转发</th>
            <th>工具</th>
            <th>本机目标</th>
            <th className="col-port">云主机端口</th>
            <th className="col-state">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const info = infos.get(r.name)!;
            const disabled = !!info.item && !info.item.enabled;
            const fwd = status?.forwards.find((f) => f.name === r.name);
            const problem = problems.get(r.name);
            return (
              <tr key={r.name} className={`${r.on ? "" : "off"} ${problem ? "bad" : ""}`}>
                <td className="col-on">
                  <input type="checkbox" checked={r.on} onChange={(e) => set(r.name, { on: e.target.checked })} aria-label={`转发 ${r.name}`} />
                </td>
                <td>
                  <span className="mcp-name">{toolLabel(r.name)}</span>
                  {disabled && <span className="muted small">（工具箱里已停用）</span>}
                  {problem && <div className="form-error small">{problem}</div>}
                </td>
                <td>
                  <code
                    className="muted"
                    title={info.item?.kind === "stdio" ? `由内置服务启动并转接：${[info.item.command, ...info.item.args].join(" ")}` : undefined}
                  >
                    {localSide(info, port)}
                  </code>
                </td>
                <td className="col-port">
                  <NumberInput min={1024} max={65535} value={r.port} disabled={!r.on} onChange={(port) => set(r.name, { port })} />
                </td>
                <td className="col-state">
                  {!r.on ? (
                    <span className="muted">不转发</span>
                  ) : fwd ? (
                    <span className={fwd.error ? "form-error inline" : "ok-text"} title={fwd.error ?? `云主机 :${fwd.remotePort} → 本机 ${fwd.target}`}>
                      {fwd.error ? "✕ 失败" : `● 已通 :${fwd.remotePort}`}
                    </span>
                  ) : (
                    <span className="muted" title={status ? "保存后重新连接时建立" : "连上主机时自动建立"}>
                      {status ? "待建立" : "未连接"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
