import { useEffect, useState } from "react";
import { api, BUILTIN_NAME, cloudNameOf, Host, HostTool, hostTools, McpHostStatus, Settings, toolLabel, ToolboxItem } from "./api";
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

/** 表格里的一行：工具箱里的一个工具在这台主机上的设置 */
export interface ToolRow {
  name: string;
  on: boolean;
  /** 云端名字；留空表示用工具箱里的默认值 */
  cloudName: string;
  port: number;
}

interface ToolInfo {
  name: string;
  /** 工具箱里的条目；内置工具为 null */
  item: ToolboxItem | null;
  defaultName: string;
  defaultPort: number;
}

/** 内置工具 + 工具箱里的所有条目，带各自的默认云端名字和端口 */
function toolInfos(s: Settings): ToolInfo[] {
  return [
    { name: BUILTIN_NAME, item: null, defaultName: cloudNameOf(s, BUILTIN_NAME), defaultPort: s.remotePort },
    ...s.toolbox.map((item) => ({ name: item.name, item, defaultName: cloudNameOf(s, item.name), defaultPort: item.remotePort })),
  ];
}

/** 把主机保存的工具展开成表格行：没改过的显示默认值 */
export function initRows(host: Host, s: Settings): ToolRow[] {
  const saved = new Map(hostTools(host).map((t) => [t.name, t]));
  return toolInfos(s).map((info) => {
    const t = saved.get(info.name);
    return { name: info.name, on: !!t, cloudName: t?.alias || info.defaultName, port: t?.remotePort ?? info.defaultPort };
  });
}

/** 表格行 → 主机保存的工具：和默认值一样的不存，工具箱里的默认值以后变了还能跟着变 */
export function rowsToTools(rows: ToolRow[], s: Settings): HostTool[] {
  const infos = new Map(toolInfos(s).map((i) => [i.name, i]));
  return rows
    .filter((r) => r.on)
    .map((r) => {
      const info = infos.get(r.name)!;
      const alias = r.cloudName.trim();
      return { name: r.name, alias: alias === info.defaultName ? "" : alias, remotePort: r.port === info.defaultPort ? null : r.port };
    });
}

/** 启用的行里名字或端口重复、名字不合法的，返回行名 → 问题 */
export function rowProblems(rows: ToolRow[], s: Settings): Map<string, string> {
  const infos = new Map(toolInfos(s).map((i) => [i.name, i]));
  const problems = new Map<string, string>();
  const on = rows.filter((r) => r.on);
  for (const r of on) {
    const name = r.cloudName.trim() || infos.get(r.name)!.defaultName;
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(name)) problems.set(r.name, "云端名字只能用英文字母、数字、- 和 _");
    else if (on.some((o) => o !== r && (o.cloudName.trim() || infos.get(o.name)!.defaultName) === name)) problems.set(r.name, `云端名字 ${name} 重复`);
    else if (!(r.port >= 1024 && r.port <= 65535)) problems.set(r.name, "端口要在 1024–65535 之间");
    else if (on.some((o) => o !== r && o.port === r.port)) problems.set(r.name, `云端端口 ${r.port} 重复`);
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

/** 主机的工具表：每行一个工具，可启用、改这台主机上的云端名字和端口 */
export function HostToolsTable({
  rows,
  onChange,
  settings,
  status,
}: {
  rows: ToolRow[];
  onChange: (rows: ToolRow[]) => void;
  settings: Settings;
  /** 这台主机当前连接上的端口映射；未连接时不显示状态列 */
  status?: McpHostStatus;
}) {
  const infos = new Map(toolInfos(settings).map((i) => [i.name, i]));
  const problems = rowProblems(rows, settings);
  const port = useLocalPort();
  const set = (name: string, patch: Partial<ToolRow>) => onChange(rows.map((r) => (r.name === name ? { ...r, ...patch } : r)));

  return (
    <div className="host-tools-table-wrap">
      <table className="host-tools-table">
        <thead>
          <tr>
            <th className="col-on" />
            <th>工具</th>
            <th>本机</th>
            <th>云端名字</th>
            <th className="col-port">云端端口</th>
            {status && <th className="col-state">映射</th>}
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
                  <input type="checkbox" checked={r.on} onChange={(e) => set(r.name, { on: e.target.checked })} aria-label={`启用 ${r.name}`} />
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
                <td>
                  <input
                    value={r.cloudName}
                    disabled={!r.on}
                    onChange={(e) => set(r.name, { cloudName: e.target.value })}
                    placeholder={info.defaultName}
                    spellCheck={false}
                  />
                </td>
                <td className="col-port">
                  <NumberInput min={1024} max={65535} value={r.port} onChange={(port) => set(r.name, { port })} />
                </td>
                {status && (
                  <td className="col-state">
                    {fwd ? (
                      <span className={fwd.error ? "form-error inline" : "ok-text"} title={fwd.error ?? `云端 :${fwd.remotePort} → 本机 ${fwd.target}`}>
                        {fwd.error ? "✕ 失败" : `● :${fwd.remotePort}`}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

