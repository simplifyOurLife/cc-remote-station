import { useState } from "react";
import { toolSummary } from "./chatModel";
import type { PermissionRequest, SubStep, ToolResult } from "./chatModel";

const ICONS: Record<string, string> = {
  Bash: "❯",
  Read: "📄",
  Write: "✎",
  Edit: "✎",
  MultiEdit: "✎",
  Glob: "⌕",
  Grep: "⌕",
  WebFetch: "🌐",
  WebSearch: "🌐",
  TodoWrite: "☑",
  Task: "✦",
};

function icon(name: string) {
  if (name.startsWith("mcp__")) return "⧉";
  return ICONS[name] ?? "⚙";
}

/** 简易 diff：旧内容标红、新内容标绿（Edit 的 old/new 片段本来就不长） */
function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <pre className="diff">
      {oldText.split("\n").map((l, i) => (
        <div key={`o${i}`} className="del">
          - {l}
        </div>
      ))}
      {newText.split("\n").map((l, i) => (
        <div key={`n${i}`} className="add">
          + {l}
        </div>
      ))}
    </pre>
  );
}

function Clipped({ text, limit = 3000 }: { text: string; limit?: number }) {
  const [all, setAll] = useState(false);
  const long = text.length > limit;
  return (
    <>
      <pre className="tool-output">{all || !long ? text : text.slice(0, limit) + "…"}</pre>
      {long && (
        <button className="link" onClick={() => setAll(!all)}>
          {all ? "收起" : `展开全部（${text.length} 字符）`}
        </button>
      )}
    </>
  );
}

/** 工具参数的详细展示，常用工具单独排版，其余显示 JSON */
function ToolInput({ name, input }: { name: string; input: Record<string, any> }) {
  if (name === "Edit") return <Diff oldText={input.old_string ?? ""} newText={input.new_string ?? ""} />;
  if (name === "MultiEdit")
    return (
      <>
        {(input.edits ?? []).map((e: any, i: number) => (
          <Diff key={i} oldText={e.old_string ?? ""} newText={e.new_string ?? ""} />
        ))}
      </>
    );
  if (name === "Write") return <Clipped text={input.content ?? ""} limit={2000} />;
  if (name === "Bash") return <pre className="tool-output">$ {input.command}</pre>;
  if (name === "TodoWrite")
    return (
      <ul className="todos">
        {(input.todos ?? []).map((t: any, i: number) => (
          <li key={i} className={t.status}>
            {t.status === "completed" ? "☑" : t.status === "in_progress" ? "◔" : "☐"} {t.content}
          </li>
        ))}
      </ul>
    );
  return <pre className="tool-output">{JSON.stringify(input, null, 2)}</pre>;
}

export function ToolCard({
  name,
  input,
  result,
  steps,
}: {
  name: string;
  input: Record<string, any>;
  result?: ToolResult;
  /** 子代理（Task）执行过的步骤 */
  steps?: SubStep[];
}) {
  // 待办清单和改文件默认展开（用户最关心），其余默认折叠
  const [open, setOpen] = useState(name === "TodoWrite" || name === "Edit" || name === "MultiEdit");
  const status = !result ? "pending" : result.isError ? "error" : "ok";
  return (
    <div className={`tool-card ${status}`}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{icon(name)}</span>
        <b>{name}</b>
        <span className="tool-summary">{toolSummary(name, input)}</span>
        {steps && steps.length > 0 && <span className="muted">{steps.filter((s) => s.kind === "tool").length} 步</span>}
        <span className="tool-status" title={status === "pending" ? "执行中" : status === "error" ? "失败" : "完成"}>
          {status === "pending" ? "RUN" : status === "error" ? "ERR" : "OK"}
        </span>
      </div>
      {open && (
        <div className="tool-body">
          <ToolInput name={name} input={input} />
          {steps && steps.length > 0 && (
            <ol className="sub-steps">
              {steps.map((s, i) => (
                <li key={i} className={s.kind}>
                  {s.kind === "tool" ? s.text : s.text.slice(0, 300)}
                </li>
              ))}
            </ol>
          )}
          {result?.text && <Clipped text={result.text} />}
        </div>
      )}
    </div>
  );
}

export function PermissionCard({
  req,
  onDecide,
}: {
  req: PermissionRequest;
  onDecide: (decision: "allow" | "always" | "deny") => void;
}) {
  return (
    <div className="permission-card">
      <div className="permission-title">
        Claude 请求使用 <b>{req.toolName}</b>
      </div>
      {req.reason && <div className="muted">{req.reason}</div>}
      <ToolInput name={req.toolName} input={req.input} />
      <div className="dialog-actions">
        <button onClick={() => onDecide("deny")}>拒绝</button>
        {req.suggestions && req.suggestions.length > 0 && (
          <button onClick={() => onDecide("always")}>本次会话都允许</button>
        )}
        <button className="primary" onClick={() => onDecide("allow")}>
          允许
        </button>
      </div>
    </div>
  );
}
