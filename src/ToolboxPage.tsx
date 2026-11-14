import { FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BuiltinSettings } from "./AccessSettings";
import { api, BUILTIN_CLOUD_NAME, BUILTIN_NAME, defaultCloudName, errorText, KeyValue, Settings, ToolboxItem, ToolboxTest, ToolBrief } from "./api";
import { useLocalPort } from "./HostTools";
import { ask } from "./modal";
import { NumberInput } from "./NumberInput";
import { Select } from "./Select";
import { ToolboxImport } from "./ToolboxImport";

/** 测试结果只留在内存里：切换页面不丢，重启后重新测 */
const testCache = new Map<string, ToolboxTest>();

const KIND_LABEL = { stdio: "本机命令", http: "HTTP 服务" };

/** 按空格拆命令行，双引号里的空格保留 */
export function splitCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

function joinCommand(parts: string[]) {
  return parts.map((p) => (/\s/.test(p) || p === "" ? `"${p}"` : p)).join(" ");
}

function parseKV(text: string, sep: string): KeyValue[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes(sep))
    .map((l) => {
      const i = l.indexOf(sep);
      return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    })
    .filter((kv) => kv.key);
}

function formatKV(list: KeyValue[], sep: string) {
  return list.map((kv) => `${kv.key}${sep}${kv.value}`).join("\n");
}

function describe(item: ToolboxItem) {
  return item.kind === "stdio" ? joinCommand([item.command, ...item.args]) : item.url;
}

/** HTTP 条目本机一侧的 host:port */
function localTarget(url: string) {
  try {
    const u = new URL(url);
    return u.port ? u.host : `${u.hostname}:${u.protocol === "https:" ? 443 : 80}`;
  } catch {
    return "";
  }
}

/** 云端 Claude Code 用的地址：本机地址的 host:port 换成云端 127.0.0.1:云端端口 */
function cloudUrl(item: ToolboxItem) {
  if (item.kind === "stdio") return `http://127.0.0.1:${item.remotePort}/mcp/${item.name}`;
  try {
    const u = new URL(item.url);
    u.hostname = "127.0.0.1";
    u.port = String(item.remotePort);
    return u.toString();
  } catch {
    return "";
  }
}

function ToolList({ tools }: { tools: ToolBrief[] }) {
  return (
    <div className="mcp-tools">
      {tools.map((t) => (
        <code key={t.name} title={t.description}>
          {t.name}
        </code>
      ))}
    </div>
  );
}

/** MCP 工具箱：内置的 cc-workstation 工具是第一项，其余是用户加的本机/局域网 MCP */
export function ToolboxPage({
  builtinPort,
  device,
  builtinAlias,
  items,
  onItemsChange,
  onAccessSaved,
}: {
  /** 内置工具的云端端口 */
  builtinPort: number;
  /** 这台电脑的标识，云端名字的后缀 */
  device: string;
  /** 内置工具的自定义云端名字 */
  builtinAlias: string;
  items: ToolboxItem[];
  onItemsChange: (items: ToolboxItem[]) => void;
  onAccessSaved: (s: Settings) => void;
}) {
  const [builtin, setBuiltin] = useState<ToolBrief[]>([]);
  const localPort = useLocalPort();
  /** 展开的行：名字 + 展开的内容 */
  const [open, setOpen] = useState<{ name: string; part: "tools" | "settings" } | null>(null);
  const [editing, setEditing] = useState<ToolboxItem | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [, rerender] = useState(0);

  useEffect(() => {
    api.toolboxBuiltin().then(setBuiltin).catch(() => {});
  }, []);

  const toggleOpen = (name: string, part: "tools" | "settings") =>
    setOpen(open?.name === name && open.part === part ? null : { name, part });

  const save = async (next: ToolboxItem[]) => {
    try {
      onItemsChange(await api.toolboxSave(next));
      setError("");
    } catch (e) {
      setError(errorText(e));
      throw e;
    }
  };

  const test = async (item: ToolboxItem) => {
    setTesting(item.name);
    setRowError((r) => ({ ...r, [item.name]: "" }));
    try {
      testCache.set(item.name, await api.toolboxTest(item));
      setOpen({ name: item.name, part: "tools" });
    } catch (e) {
      testCache.delete(item.name);
      setRowError((r) => ({ ...r, [item.name]: errorText(e) }));
    } finally {
      setTesting(null);
      rerender((n) => n + 1);
    }
  };

  const remove = async (item: ToolboxItem) => {
    const ok = await ask(`从工具箱删除「${item.name}」？\n已配置它的主机需要重新「配置 Claude」才会从云端移除。`, {
      title: "删除 MCP",
      kind: "warning",
      okLabel: "删除",
    });
    if (ok) await save(items.filter((i) => i.name !== item.name)).catch(() => {});
  };

  const submit = async (item: ToolboxItem, original: string | null) => {
    const next = original === null ? [...items, item] : items.map((i) => (i.name === original ? item : i));
    await save(next);
    if (original !== null && original !== item.name) testCache.delete(original);
    setEditing(null);
  };

  return (
    <section className="page-card toolbox">
      <div className="card-head">
        <div>
          <h3>工具箱</h3>
          <p className="muted">每个工具一条端口映射：云主机上的 127.0.0.1:云端端口 转发到本机。哪台主机用哪些工具，在主机的「MCP 工具」里选。</p>
        </div>
        <div className="card-head-actions">
          <button onClick={() => setImporting(true)} title="从本机 Claude Code / Claude Desktop / Cursor 的配置里批量导入">
            ↓ 从本机导入
          </button>
          <button className="primary" onClick={() => setEditing("new")}>
            ＋ 添加 MCP
          </button>
        </div>
      </div>

      <div className="tool-list">
        <div className="tool-row">
          <div className="tool-row-main">
            <span className="mcp-state ok" />
            <span className="tool-name">{BUILTIN_CLOUD_NAME}</span>
            <span className="toolbox-kind">内置</span>
            <div className="grow" />
            <div className="tool-actions">
              <button onClick={() => toggleOpen(BUILTIN_NAME, "settings")}>
                {open?.name === BUILTIN_NAME && open.part === "settings" ? "收起" : "编辑"}
              </button>
            </div>
          </div>
          <div className="tool-row-meta">
            <button className="cloud-name" title="在云端 Claude Code 里的名字，点击修改" onClick={() => setOpen({ name: BUILTIN_NAME, part: "settings" })}>
              ☁ {builtinAlias || defaultCloudName(BUILTIN_NAME, device)}
            </button>
            <span className="toolbox-map" title="文件读写与搜索、执行命令、剪贴板、通知">
              127.0.0.1:{localPort ?? "…"} <span className="arrow">→</span> 云端 :{builtinPort}
            </span>
            {builtin.length > 0 && (
              <button className="link" onClick={() => toggleOpen(BUILTIN_NAME, "tools")}>
                {builtin.length} 个工具 {open?.name === BUILTIN_NAME && open.part === "tools" ? "▴" : "▾"}
              </button>
            )}
          </div>
          {open?.name === BUILTIN_NAME && open.part === "tools" && <ToolList tools={builtin} />}
          {open?.name === BUILTIN_NAME && open.part === "settings" && <BuiltinSettings onSaved={onAccessSaved} />}
        </div>

        {items.map((item) => {
          const result = testCache.get(item.name);
          const isOpen = open?.name === item.name;
          return (
            <div key={item.name} className={`tool-row ${item.enabled ? "" : "off"}`}>
              <div className="tool-row-main">
                <span className={`mcp-state ${rowError[item.name] ? "error" : item.enabled ? "ok" : "idle"}`} />
                <span className="tool-name">{item.name}</span>
                <span className="toolbox-kind">
                  {KIND_LABEL[item.kind]}
                  {item.kind === "http" && item.legacySse && " · SSE"}
                </span>
                {!item.enabled && <span className="muted small">已停用</span>}
                <div className="grow" />
                <div className="tool-actions">
                  <button disabled={testing === item.name} onClick={() => test(item)}>
                    {testing === item.name ? "测试中…" : "测试"}
                  </button>
                  <button onClick={() => setEditing(item)}>编辑</button>
                  <label className="checkbox toolbox-switch" title="停用后云端暂时用不了它，不用重新配置主机">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(e) => save(items.map((i) => (i.name === item.name ? { ...i, enabled: e.target.checked } : i))).catch(() => {})}
                    />
                    启用
                  </label>
                  <button className="icon" title="删除" onClick={() => remove(item)}>
                    ×
                  </button>
                </div>
              </div>
              <div className="tool-row-meta">
                <button className="cloud-name" title="在云端 Claude Code 里的名字，点击修改" onClick={() => setEditing(item)}>
                  ☁ {item.alias || defaultCloudName(item.name, device)}
                </button>
                <span className="toolbox-map" title={`${describe(item)}\n云端地址：${cloudUrl(item)}`}>
                  <code className="toolbox-desc">{item.kind === "stdio" ? describe(item) : localTarget(item.url)}</code>
                  <span className="arrow">→</span> 云端 :{item.remotePort}
                </span>
                {result ? (
                  <button className="link" onClick={() => toggleOpen(item.name, "tools")}>
                    {result.tools.length} 个工具 {isOpen ? "▴" : "▾"}
                  </button>
                ) : (
                  <span className="muted">未测试</span>
                )}
              </div>
              {rowError[item.name] && <div className="form-error mcp-error">{rowError[item.name]}</div>}
              {isOpen && result && (
                <>
                  {result.server && <div className="muted tool-server">{result.server}</div>}
                  <ToolList tools={result.tools} />
                </>
              )}
            </div>
          );
        })}
      </div>
      {items.length === 0 && (
        <p className="muted toolbox-empty">
          还没有其他 MCP。可以加本机命令（如 <code>npx -y @playwright/mcp@latest</code>，让云端 Claude 操作你本机的浏览器），
          或本机/局域网的 HTTP MCP 地址。
        </p>
      )}
      {error && <p className="form-error">{error}</p>}

      {/* 弹窗挂到 body：卡片的切角 clip-path 会把 fixed 定位的弹窗也裁掉 */}
      {editing &&
        createPortal(
          <ToolboxForm
            initial={editing === "new" ? null : editing}
            others={items.filter((i) => editing === "new" || i.name !== editing.name)}
            builtinPort={builtinPort}
            device={device}
            onSubmit={(item) => submit(item, editing === "new" ? null : editing.name)}
            onCancel={() => setEditing(null)}
          />,
          document.body,
        )}
      {importing &&
        createPortal(
          <ToolboxImport
            items={items}
            builtinPort={builtinPort}
            onImport={async (added) => {
              await save([...items, ...added]);
              setImporting(false);
            }}
            onCancel={() => setImporting(false)}
          />,
          document.body,
        )}
    </section>
  );
}

function ToolboxForm({
  initial,
  others,
  builtinPort,
  device,
  onSubmit,
  onCancel,
}: {
  initial: ToolboxItem | null;
  /** 其他条目：名字和云端端口不能重复 */
  others: ToolboxItem[];
  builtinPort: number;
  device: string;
  onSubmit: (item: ToolboxItem) => Promise<void>;
  onCancel: () => void;
}) {
  const usedPorts = [builtinPort, ...others.map((i) => i.remotePort)];
  const [name, setName] = useState(initial?.name ?? "");
  const [alias, setAlias] = useState(initial?.alias ?? "");
  // 新条目默认取已用端口里最大的下一个
  const [remotePort, setRemotePort] = useState(initial?.remotePort || Math.max(...usedPorts, 47823) + 1);
  const [kind, setKind] = useState<ToolboxItem["kind"]>(initial?.kind ?? "stdio");
  const [commandLine, setCommandLine] = useState(initial?.kind === "stdio" ? joinCommand([initial.command, ...initial.args]) : "");
  const [cwd, setCwd] = useState(initial?.kind === "stdio" ? initial.cwd ?? "" : "");
  const [envText, setEnvText] = useState(initial?.kind === "stdio" ? formatKV(initial.env, "=") : "");
  const [url, setUrl] = useState(initial?.kind === "http" ? initial.url : "");
  const [headersText, setHeadersText] = useState(initial?.kind === "http" ? formatKV(initial.headers, ": ") : "");
  const [legacySse, setLegacySse] = useState(initial?.kind === "http" && initial.legacySse);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ToolboxTest | null>(null);
  const [error, setError] = useState("");

  /** 把表单变成条目；不合法时抛出提示文字 */
  const build = (): ToolboxItem => {
    const n = name.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(n)) throw "名字只能用英文字母、数字、- 和 _，最多 32 个字符";
    if (n === BUILTIN_NAME || n === BUILTIN_CLOUD_NAME) throw `名字 ${n} 已被内置工具占用`;
    if (others.some((i) => i.name === n)) throw `工具箱里已经有「${n}」`;
    if (!(remotePort >= 1024 && remotePort <= 65535)) throw "云端端口要在 1024–65535 之间";
    if (remotePort === builtinPort) throw `云端端口 ${remotePort} 已被内置工具占用`;
    const clash = others.find((i) => i.remotePort === remotePort);
    if (clash) throw `云端端口 ${remotePort} 已被「${clash.name}」占用`;
    const a = alias.trim();
    if (a && !/^[A-Za-z0-9_-]{1,48}$/.test(a)) throw "云端名字只能用英文字母、数字、- 和 _";
    const enabled = initial?.enabled ?? true;
    const base = { name: n, enabled, remotePort, alias: a };
    if (kind === "stdio") {
      const [command, ...args] = splitCommand(commandLine.trim());
      if (!command) throw "请填启动命令";
      return { ...base, kind, command, args, env: parseKV(envText, "="), cwd: cwd.trim() || null };
    }
    if (!/^https?:\/\/\S+$/.test(url.trim()) || !localTarget(url.trim())) throw "本机地址要以 http:// 或 https:// 开头，如 http://127.0.0.1:17823/mcp";
    return { ...base, kind, url: url.trim(), headers: parseKV(headersText, ":"), legacySse };
  };

  const run = async (action: (item: ToolboxItem) => Promise<void>) => {
    let item: ToolboxItem;
    try {
      item = build();
    } catch (msg) {
      setError(String(msg));
      return;
    }
    setError("");
    try {
      await action(item);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const test = () =>
    run(async (item) => {
      setTesting(true);
      setResult(null);
      try {
        const r = await api.toolboxTest(item);
        testCache.set(item.name, r);
        setResult(r);
      } finally {
        setTesting(false);
      }
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(onSubmit);
  };

  return (
    <div className="terminal-overlay">
      <form className="dialog host-form toolbox-form" onSubmit={submit}>
        <h3>{initial ? `编辑 ${initial.name}` : "添加 MCP"}</h3>
        <div className="row">
          <label className="grow">
            名字：
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 playwright" autoFocus />
            <span className="muted small">工具箱里的名字，英文</span>
          </label>
          <label className="grow">
            云端名字：
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={`默认 ${defaultCloudName(name.trim() || "名字", device)}`}
              spellCheck={false}
            />
            <span className="muted small">云端 Claude 里显示的名字，工具会叫 mcp__云端名字__工具名</span>
          </label>
        </div>
        <div className="row">
          <label className="toolbox-kind-field">
            类型：
            <Select
              value={kind}
              onChange={(k) => {
                setKind(k);
                setResult(null);
              }}
              options={[
                { value: "stdio", label: "本机命令", hint: "stdio" },
                { value: "http", label: "HTTP 服务", hint: "本机或局域网" },
              ]}
            />
          </label>
        </div>

        {kind === "stdio" ? (
          <>
            <label>
              启动命令：
              <input
                value={commandLine}
                onChange={(e) => setCommandLine(e.target.value)}
                placeholder="npx -y @playwright/mcp@latest"
                spellCheck={false}
              />
              <span className="muted small">由 cc-workstation 在本机启动，云端第一次用到时才运行；含空格的参数用双引号括起来</span>
            </label>
            <label>
              工作目录：
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="可选" spellCheck={false} />
            </label>
            <label>
              环境变量：
              <textarea
                rows={3}
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={"可选，每行一个\nAPI_KEY=xxxx"}
                spellCheck={false}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              本机地址：
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:17823/mcp" spellCheck={false} />
              <span className="muted small">本机或局域网里 MCP 服务的完整地址，其中的 host:port 就是转发目标</span>
            </label>
            <label>
              请求头：
              <textarea
                rows={2}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder={"可选，每行一个\nAuthorization: Bearer xxxx"}
                spellCheck={false}
              />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={legacySse} onChange={(e) => setLegacySse(e.target.checked)} />
              旧版 SSE 协议：地址一般以 /sse 结尾；不确定时先不勾，测试失败再试
            </label>
          </>
        )}

        <div className="port-map">
          <div className="port-map-side">
            <div className="muted small">本机</div>
            <code>{kind === "stdio" ? "工具箱启动的命令" : localTarget(url.trim()) || "—"}</code>
          </div>
          <span className="port-map-arrow">→</span>
          <label className="port-map-side">
            <div className="muted small">云主机 127.0.0.1 的端口</div>
            <NumberInput min={1024} max={65535} value={remotePort} onChange={setRemotePort} />
          </label>
        </div>
        {(() => {
          let preview = "";
          try {
            preview = cloudUrl(build());
          } catch {
            // 表单还没填完，不显示预览
          }
          const shown = alias.trim() || defaultCloudName(name.trim(), device);
          return (
            preview && (
              <p className="muted small">
                云端 Claude Code 里叫 <code>{shown}</code>，连接 <code>{preview}</code>
              </p>
            )
          );
        })()}

        {result && (
          <div className="toolbox-result">
            <span className="ok">●</span> 连接成功{result.server && `：${result.server}`}，共 {result.tools.length} 个工具
            <ToolList tools={result.tools} />
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={testing} onClick={test}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          <div className="grow" />
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary">
            保存
          </button>
        </div>
      </form>
    </div>
  );
}
