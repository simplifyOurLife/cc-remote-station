import { useEffect, useState } from "react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { api, AuditEntry, BackupEntry, errorText } from "./api";

/** 云端 Claude Code 经 MCP 对本机做过的操作（审计），以及改动前的备份（可恢复） */
export function ActivityDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<"audit" | "backup">("audit");
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.auditDays().then((d) => {
      setDays(d);
      if (d[0]) setDay(d[0]);
    });
    api.backupsList().then(setBackups);
  }, []);

  useEffect(() => {
    if (day) api.auditEntries(day).then(setEntries);
  }, [day]);

  const restore = async (b: BackupEntry) => {
    const ok = await ask(`把备份恢复到：\n${b.original}\n\n当前文件会先备份，恢复可以撤销。`, { title: "恢复备份", kind: "warning" });
    if (!ok) return;
    try {
      const path = await api.backupRestore(b.id);
      await message(`已恢复 ${path}`, { title: "恢复成功", kind: "info" });
      setBackups(await api.backupsList());
    } catch (e) {
      setError(errorText(e));
    }
  };

  const shown = onlyErrors ? entries.filter((e) => !e.ok) : entries;

  return (
    <div className="terminal-overlay">
      <div className="dialog activity">
        <div className="row activity-head">
          <h3 className="grow">云端操作记录</h3>
          <div className="segmented">
            <button className={view === "audit" ? "on" : ""} onClick={() => setView("audit")}>
              操作审计
            </button>
            <button className={view === "backup" ? "on" : ""} onClick={() => setView("backup")}>
              文件备份
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}

        {view === "audit" && (
          <>
            <div className="row activity-filter">
              <label>
                日期：
                <select value={day} onChange={(e) => setDay(e.target.value)}>
                  {days.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
                只看失败
              </label>
              <span className="muted">共 {shown.length} 条</span>
            </div>
            <div className="activity-table">
              {shown.map((e, i) => (
                <div key={i} className={`activity-row ${e.ok ? "" : "failed"}`}>
                  <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
                  <code>{e.tool}</code>
                  <span className="activity-args" title={JSON.stringify(e.args, null, 2)}>
                    {summarize(e)}
                  </span>
                  <span className="muted">{e.ms}ms</span>
                </div>
              ))}
              {days.length === 0 && <p className="muted">还没有云端操作记录</p>}
            </div>
          </>
        )}

        {view === "backup" && (
          <div className="activity-table">
            {backups.map((b) => (
              <div key={b.id} className="activity-row">
                <span className="muted">{new Date(b.ts).toLocaleString()}</span>
                <code>{b.reason}</code>
                <span className="activity-args" title={b.original}>
                  {b.original}
                </span>
                <button onClick={() => restore(b)}>恢复</button>
              </div>
            ))}
            {backups.length === 0 && <p className="muted">还没有备份（保留 14 天）</p>}
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 一行展示审计要点：失败显示原因，否则显示路径/命令等关键参数 */
export function summarize(e: AuditEntry): string {
  if (!e.ok && e.error) return e.error;
  const a = e.args as Record<string, string>;
  return a.path ?? a.command ?? (a.from ? `${a.from} → ${a.to}` : null) ?? a.target ?? a.task_id ?? "";
}
