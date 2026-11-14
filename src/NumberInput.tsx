/** 数字输入框：隐藏原生的上下调节按钮，换成工具风格的 ＋/－。仍是 type=number，键盘上下键和表单校验照常 */
export function NumberInput(p: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
}) {
  const step = p.step ?? 1;
  const bump = (dir: 1 | -1) => {
    let n = (Number.isFinite(p.value) ? p.value : (p.min ?? 0)) + dir * step;
    if (p.min !== undefined) n = Math.max(p.min, n);
    if (p.max !== undefined) n = Math.min(p.max, n);
    p.onChange(n);
  };
  return (
    <span className="number-input">
      <input
        type="number"
        required={p.required}
        min={p.min}
        max={p.max}
        step={step}
        value={p.value}
        onChange={(e) => p.onChange(Number(e.target.value))}
      />
      <span className="number-steps">
        {([1, -1] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            tabIndex={-1}
            aria-label={dir > 0 ? "增加" : "减少"}
            disabled={dir > 0 ? p.max !== undefined && p.value >= p.max : p.min !== undefined && p.value <= p.min}
            // 不抢输入框焦点；包在 <label> 里时也不触发标签的默认行为
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.preventDefault();
              bump(dir);
            }}
          >
            <span className={`number-arrow ${dir > 0 ? "up" : "down"}`} aria-hidden="true" />
          </button>
        ))}
      </span>
    </span>
  );
}
