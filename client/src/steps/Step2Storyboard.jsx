import React, { useState, useEffect } from 'react';
import { fetchStyles, applyStyle, regenerateStyle } from '../api.js';
import ProgressBar from '../components/ProgressBar.jsx';
import useProgress from '../hooks/useProgress.js';

function TextField({ label, value, onChange, rows = 2, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}{hint && <em className="hint-en">{hint}</em>}</span>
      <textarea rows={rows} value={value || ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** 中英双语提示词编辑块：英文（实际发送给模型） + 中文（对照/可编辑） */
function Bilingual({ label, en, zh, onEn, onZh, rows = 3 }) {
  return (
    <div className="bilingual">
      <TextField label={`${label}（English · 实际发送）`} value={en} onChange={onEn} rows={rows} />
      <TextField label={`${label}（中文对照）`} value={zh} onChange={onZh} rows={rows} hint="中文仅作对照/可编辑" />
    </div>
  );
}

export default function Step2Storyboard({
  jobId, storyboard, setStoryboard, analysis, segCount, onChange, onSegmentChange, onConfirm, onBack,
}) {
  const o = analysis?.overall || {};
  const sb = storyboard || {};
  const [styles, setStyles] = useState(null); // { catalog, recommended, selected }
  const [selected, setSelected] = useState([]);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleMsg, setStyleMsg] = useState('');
  // 生成期间实时拉取后端进度，把「批次 X/Y、第 A-B 镜」等详细标签显示到进度条（替代固定文案）
  const { progress: genProgress } = useProgress(jobId, styleBusy);

  // 加载画风目录 + 基于音乐/歌词的推荐
  useEffect(() => {
    let alive = true;
    fetchStyles(jobId)
      .then((d) => { if (alive) { setStyles(d); setSelected(d.selected || []); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [jobId]);

  // 单选：选中某画风即取消其它；再次点击已选中的可取消（回到未选状态）
  function toggleStyle(id) {
    setSelected((prev) => (prev.includes(id) ? [] : [id]));
  }

  // 是否已生成分镜脚本（视觉设定集/全局提示词/分镜提示词）。未生成前只展示分析 + 画风选择。
  const sbReady = Boolean(sb && Array.isArray(sb.segments) && sb.segments.length);

  // 首次生成 / 换画风后重新生成：按所选画风调用 AI 生成分镜脚本（唯一生成入口）
  async function handleGenerate() {
    if (selected.length === 0) return;
    setStyleBusy(true);
    setStyleMsg('正在按所选画风生成分镜脚本（AI，约 15-40s，请稍候）…');
    try {
      const res = await regenerateStyle(jobId, selected);
      setStoryboard(res.storyboard);
      setStyleMsg(`分镜脚本已按所选画风「${list.find((s) => s.id === selected[0])?.zh || ''}」生成`);
    } catch (e) {
      setStyleMsg('生成失败：' + e.message);
    } finally {
      setStyleBusy(false);
    }
  }

  // 已生成后：把新画风即时注入现有提示词（不重跑 LLM，从基版重注入，秒级切换画风）
  async function handleApply() {
    if (selected.length === 0) return;
    setStyleBusy(true);
    setStyleMsg('');
    try {
      const res = await applyStyle(jobId, selected);
      setStoryboard(res.storyboard);
      setStyleMsg(`已将画风「${list.find((s) => s.id === selected[0])?.zh || ''}」即时注入分镜提示词（含全局与每段）`);
    } catch (e) {
      setStyleMsg('注入失败：' + e.message);
    } finally {
      setStyleBusy(false);
    }
  }

  const list = styles?.recommended || styles?.catalog || [];

  return (
    <section className="panel">
      <h2>步骤 2 · 分镜脚本（中文脚本 + 中英双语提示词，均可编辑）</h2>

      {analysis && (
        <div className="card analysis">
          <b>mert 分析结果：</b>
          <span>流派 {o.genre}</span>
          <span>情绪 {o.mood}</span>
          <span>{o.tempoBpm} BPM</span>
          <span>配色 {o.colorPalette}</span>
        </div>
      )}

      {/* 画风选择 */}
      <div className="style-section">
        <h3>选择画风（基于音乐 + 歌词综合分析推荐，单选）</h3>
        {!styles && <div className="zh-ref">画风加载中…</div>}
        <div className="style-grid">
          {list.map((s) => {
            const isSel = selected.includes(s.id);
            return (
              <button
                key={s.id}
                className={`style-chip ${isSel ? 'selected' : ''} ${s.recommended ? 'recommended' : ''}`}
                onClick={() => toggleStyle(s.id)}
                type="button"
              >
                {s.recommended && <span className="rec-badge">推荐</span>}
                <span className="chip-zh">{s.zh}</span>
                <span className="chip-en">{s.en}</span>
              </button>
            );
          })}
        </div>
        <div className="row style-actions">
          {!sbReady ? (
            <button className="primary" disabled={styleBusy || selected.length === 0} onClick={handleGenerate}>
              {styleBusy ? '生成中…' : '确定画风，生成分镜脚本（AI）'}
            </button>
          ) : (
            <>
              <button className="primary" disabled={styleBusy || selected.length === 0} onClick={handleApply}>
                {styleBusy ? '处理中…' : '应用所选画风（即时切换）'}
              </button>
              <button className="ghost" disabled={styleBusy || selected.length === 0} onClick={handleGenerate}>
                {styleBusy ? '处理中…' : '用所选画风重新生成（AI）'}
              </button>
            </>
          )}
          <span className="count">{selected.length === 1 ? `已选画风：${list.find((s) => s.id === selected[0])?.zh || ''}` : '未选择画风（单选，必选）'}</span>
        </div>
        {styleBusy && (
          <ProgressBar
            percent={genProgress?.percent || 0}
            label={genProgress?.label || (sbReady ? '正在处理画风（即时切换 / AI 重新生成）…' : '正在按所选画风生成视觉设定集、全局提示词与分镜提示词…')}
            detail={genProgress?.detail || ''}
          />
        )}
        {styleMsg && <div className="zh-ref">{styleMsg}</div>}
        {!sbReady && !styleBusy && (
          <div className="zh-ref" style={{ marginTop: 6 }}>
            请先选择一种画风，再点击「确定画风，生成分镜脚本」。视觉设定集、全局提示词与分镜提示词将据此一次性生成。
          </div>
        )}
      </div>

      {!sbReady ? (
        <div className="card" style={{ marginTop: 12, padding: 16, lineHeight: 1.7 }}>
          <b>尚未生成分镜脚本</b>
          <div className="zh-ref" style={{ marginTop: 6 }}>
            视觉设定集、全局提示词与分镜提示词会在你<strong>选定画风并点击「确定画风，生成分镜脚本」</strong>后，
            由 AI 结合音乐/歌词分析结果一次性生成。请先在上方选择画风。
          </div>
        </div>
      ) : (
        <>
          <h3>视觉设定集（Visual Bible · 中文，保证角色与风格一致）</h3>
          <TextField label="视觉设定集（中文：风格 / 主角外貌·服装·发色·体型 / 色调·光影）"
            value={sb.visualBible} onChange={(v) => onChange({ visualBible: v })} rows={3} />

          <h3>全局提示词（中英双语，实际发送英文）</h3>
          <Bilingual
            label="文生图全局提示词"
            en={sb.globalPrompt} zh={sb.globalPromptZh}
            onEn={(v) => onChange({ globalPrompt: v })} onZh={(v) => onChange({ globalPromptZh: v })} rows={3}
          />
          <Bilingual
            label="图生视频全局提示词"
            en={sb.globalVideoPrompt} zh={sb.globalVideoPromptZh}
            onEn={(v) => onChange({ globalVideoPrompt: v })} onZh={(v) => onChange({ globalVideoPromptZh: v })} rows={3}
          />

          <h3>分镜明细（{segCount} 段，每段 10 秒 · 中文画面描述 + 中英提示词）</h3>
          <div className="seg-list">
            {(sb.segments || []).map((seg, i) => (
              <div className="seg" key={i}>
                <div className="seg-head">
                  <span>第 {i + 1} 镜 · {seg.shot ? `Shot ${seg.shot} · ` : ''}{seg.timeRange || `${i * 10}-${(i + 1) * 10}s`}</span>
                  <span className="seg-badges">
                    {seg.cameraMovement && (
                      <span className="cam-badge" title={seg.cameraMovementEn || ''}>
                        <span className="cam-dot" />{seg.cameraMovement}
                      </span>
                    )}
                    {seg.shotSize && (
                      <span className="shot-badge" title="景别（由音频响度 LUFS 映射：响度越大越近景）">
                        <span className="shot-dot" />{seg.shotSize}
                      </span>
                    )}
                    {seg.transition && (
                      <span className="trans-badge" title="转场（由相邻段落能量变化 dB 映射）">
                        <span className="trans-dot" />{seg.transition}
                      </span>
                    )}
                  </span>
                </div>
                <div className="seg-cap">{seg.caption}</div>
                <Bilingual
                  label="文生图提示词"
                  en={seg.imagePrompt} zh={seg.imagePromptZh}
                  onEn={(v) => onSegmentChange(i, 'imagePrompt', v)}
                  onZh={(v) => onSegmentChange(i, 'imagePromptZh', v)}
                />
                <Bilingual
                  label="图生视频提示词"
                  en={seg.videoPrompt} zh={seg.videoPromptZh}
                  onEn={(v) => onSegmentChange(i, 'videoPrompt', v)}
                  onZh={(v) => onSegmentChange(i, 'videoPromptZh', v)}
                />
              </div>
            ))}
          </div>
        </>
      )}

      <div className="row">
        <button className="ghost" onClick={onBack}>← 上一步</button>
        <button className="primary" disabled={!sbReady} onClick={onConfirm} title={sbReady ? '' : '请先生成分镜脚本'}>确认分镜，进入图片生成 →</button>
      </div>
    </section>
  );
}
