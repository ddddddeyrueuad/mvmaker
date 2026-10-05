import React from 'react';

/**
 * 通用进度条。
 * - 确定模式：传 value/max（显示 done/total + 百分比），或传 percent 直接指定百分比。
 * - 不确定模式：indeterminate=true（滚动动画，用于时长不定的 AI 生成/合成）。
 * - warn=true 时进度条变红并提示（如任务可能卡死）。
 */
export default function ProgressBar({
  value = 0,
  max = 0,
  percent = null,
  indeterminate = false,
  label = '',
  detail = '',
  unit = '',
  warn = false,
}) {
  const pct = percent != null
    ? Math.min(100, Math.max(0, Math.round(percent)))
    : (max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0);

  return (
    <div className={`progress-wrap ${warn ? 'progress-warn' : ''}`}>
      <div className="progress-head">
        <span className="progress-label">{label}</span>
        {!indeterminate && (
          <span className="progress-num">{percent != null ? `${pct}%` : `${value} / ${max}${unit} · ${pct}%`}</span>
        )}
      </div>
      <div className={`progress-track ${indeterminate ? 'indeterminate' : ''}`}>
        {indeterminate
          ? <div className="progress-bar-indet" />
          : <div className="progress-bar" style={{ width: `${pct}%` }} />}
      </div>
      {detail && <div className="progress-detail">{detail}</div>}
    </div>
  );
}
