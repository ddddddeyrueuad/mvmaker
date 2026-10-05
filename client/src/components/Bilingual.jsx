import React from 'react';

export function TextField({ label, value, onChange, rows = 2, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <em className="hint-en">{hint}</em>}</span>
      <textarea rows={rows} value={value || ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/**
 * 中英双语提示词编辑块：en / zh 均可编辑。
 * active 标记"最近被编辑的语言"（'en' | 'zh'），生成时将使用 active 对应的那一语言文本，
 * 从而保证「无论修改中文还是英文提示词，都有效」。
 */
export function Bilingual({ label, en, zh, onEn, onZh, rows = 3, active = 'en' }) {
  return (
    <div className="bilingual">
      <TextField
        label={`${label} · English${active === 'en' ? '（实际用于生成）' : ''}`}
        value={en}
        onChange={onEn}
        rows={rows}
      />
      <TextField
        label={`${label} · 中文${active === 'zh' ? '（实际用于生成）' : '（可编辑）'}`}
        value={zh}
        onChange={onZh}
        rows={rows}
      />
    </div>
  );
}
