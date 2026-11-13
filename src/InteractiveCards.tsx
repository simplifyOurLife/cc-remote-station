import { useState } from "react";
import type { PermissionRequest } from "./chatModel";
import { Markdown } from "./Markdown";

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Claude 的 AskUserQuestion：逐题选择（可多选、可自填），答案按「问题 → 选项」回传 */
export function QuestionCard({
  req,
  onSubmit,
  onCancel,
}: {
  req: PermissionRequest;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const questions: Question[] = req.input.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      if (!q.multiSelect) return { ...p, [q.question]: [label] };
      return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
    });

  /** 每题的最终答案：选中的选项 + 自填内容，多个用顿号拼接 */
  const answerOf = (q: Question) => [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean).join(", ");
  const complete = questions.every((q) => answerOf(q));

  return (
    <div className="permission-card question-card">
      <div className="permission-title">Claude 想问你{questions.length > 1 ? ` ${questions.length} 个问题` : ""}</div>
      {questions.map((q) => (
        <div key={q.question} className="question">
          <div className="question-text">
            {q.header && <span className="question-tag">{q.header}</span>}
            {q.question}
            {q.multiSelect && <span className="muted">（可多选）</span>}
          </div>
          <div className="question-options">
            {q.options.map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button key={o.label} className={`option ${on ? "on" : ""}`} onClick={() => toggle(q, o.label)}>
                  <b>{o.label}</b>
                  {o.description && <span className="muted">{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            value={other[q.question] ?? ""}
            placeholder="其他（自己填写）"
            onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
          />
        </div>
      ))}
      <div className="dialog-actions">
        <button onClick={onCancel}>不回答</button>
        <button
          className="primary"
          disabled={!complete}
          onClick={() => onSubmit(Object.fromEntries(questions.map((q) => [q.question, answerOf(q)])))}
        >
          提交回答
        </button>
      </div>
    </div>
  );
}

/** 计划模式的 ExitPlanMode：展示计划，批准后按所选权限模式开始执行，或带修改意见退回 */
export function PlanCard({
  req,
  onApprove,
  onRevise,
}: {
  req: PermissionRequest;
  onApprove: (mode: "acceptEdits" | "default") => void;
  onRevise: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  return (
    <div className="permission-card plan-card">
      <div className="permission-title">Claude 提交了执行计划</div>
      <div className="plan-body">
        <Markdown text={req.input.plan ?? ""} />
      </div>
      <textarea
        value={feedback}
        rows={2}
        placeholder="要修改计划的话，在这里写意见"
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="dialog-actions">
        <button disabled={!feedback.trim()} onClick={() => onRevise(feedback.trim())}>
          继续修改计划
        </button>
        <button onClick={() => onApprove("default")}>批准（逐条审批执行）</button>
        <button className="primary" onClick={() => onApprove("acceptEdits")}>
          批准并自动接受编辑
        </button>
      </div>
    </div>
  );
}
