import React, { useState, useRef } from 'react';
import { generateImage, abortJob } from '../api.js';
import { runBatchWithRescue } from './runBatchWithRescue.js';
import ProgressBar from '../components/ProgressBar.jsx';
import Lightbox from '../components/Lightbox.jsx';
import { Bilingual } from '../components/Bilingual.jsx';
import useProgress from '../hooks/useProgress.js';

export default function Step3Images({
  job, storyboard, images, onChange, onSegmentChange, setImage, onConfirm, onBack, orientation = 'landscape',
}) {
  const n = job.segments.length;
  const dirLabel = orientation === 'portrait' ? '竖屏 3:4（1024×1792）' : '横屏 4:3（1792×1024）';
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [cooling, setCooling] = useState(false);
  const [phase, setPhase] = useState(''); // '生成' | '抢救（第 X/Y 轮）' | ''
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(null); // 灯箱
  const [noCharacter, setNoCharacter] = useState(false); // 纯景模式
  const [referenceImage, setReferenceImage] = useState(null); // 图生图参考角色图片（base64 data URI）
  const [refPreview, setRefPreview] = useState(null); // 预览用
  const cancelled = useRef(false);
  const abortRef = useRef(null);
  const { progress: backend, stalled } = useProgress(job?.jobId, busy);

  // 记录每段提示词"最近编辑的语言"，生成时使用该语言文本（保证改中文或英文都生效）。
  const [active, setActive] = useState({});
  const activeRef = useRef(active);
  const mark = (key, lang) => setActive((p) => { const n = { ...p, [key]: lang }; activeRef.current = n; return n; });

  const doneCount = images.filter(Boolean).length;
  const allDone = doneCount === n;

  // 参考角色图片上传（图生图模式）
  function handleRefImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setReferenceImage(reader.result);
      setRefPreview(reader.result);
    };
    reader.readAsDataURL(file);
  }
  function clearRefImage() {
    setReferenceImage(null);
    setRefPreview(null);
  }

  async function generateOne(i) {
    const controller = new AbortController();
    abortRef.current = controller;
    // 取最近编辑的语言作为实际发送的提示词（中文或英文），两者皆可生效。
    const a = activeRef.current;
    const segLang = a[`seg-${i}`] || 'en';
    const seg = storyboard.segments[i] || {};
    const segPrompt = segLang === 'zh' ? seg.imagePromptZh : seg.imagePrompt;
    const gLang = a.global || 'en';
    const gPrompt = gLang === 'zh' ? storyboard.globalPromptZh : storyboard.globalPrompt;
    // 分段级纯景优先（系统按「歌词+能量+冷暖」配额算出 seg.noCharacter），全局「强制纯景」开关兜底。
    const segNoChar = seg.noCharacter || noCharacter;
    const rec = await generateImage(job.jobId, i, segPrompt, gPrompt, controller.signal, {
      noCharacter: segNoChar,
      referenceImage: segNoChar ? null : referenceImage, // 纯景模式不传参考图
    });
    abortRef.current = null;
    // 同上 URL 固定为 img_xxx.png，重生成会覆盖文件但 URL 不变 → 浏览器缓存旧图。
    // 追加时间戳缓存戳，使每次（含重生成）src 不同，强制刷新缩略图。
    const busted = `${rec.url}${rec.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    setImage(i, { index: i, url: busted, prompt: segPrompt });
  }

  async function batchGenerate() {
    setBusy(true);
    setError('');
    setPhase('');
    cancelled.current = false;
    try {
      await abortJob(job.jobId, false); // 清除上一次的取消标记
      // 第一遍生成全部段；失败段不中断，跑完后冷却再自动抢数（runBatchWithRescue 内部处理）。
      const { failed, cancelled: c } = await runBatchWithRescue({
        n,
        generateOne,
        shouldCancel: () => cancelled.current,
        setProgress,
        setCooling,
        setPhase,
      });
      if (c) return;
      if (failed.length) {
        const idxs = failed.map((i) => i + 1).join('、');
        setError(`以下镜头始终生成失败（已冷却后多次自动重试仍失败，未降级占位）：${idxs} 镜。可手动重生成这几段，或检查 Agnes 服务后重试。`);
      }
    } catch (e) {
      if (e.message !== '已取消') setError(e.message);
    } finally {
      setBusy(false);
      setProgress(null);
      setCooling(false);
      setPhase('');
    }
  }

  async function regen(i) {
    setProgress(i);
    setError('');
    try {
      await abortJob(job.jobId, false); // 进入单张重生成前清除取消标记
      await generateOne(i);
    } catch (e) {
      if (e.message !== '已取消') setError(e.message);
    } finally {
      setProgress(null);
    }
  }

  function handleBack() {
    cancelled.current = true;
    abortRef.current?.abort();
    abortJob(job.jobId, true);
    onBack();
  }

  return (
    <section className="panel">
      <h2>步骤 3 · 文生图（{dirLabel} · 按顺序显示，可重生成 / 改提示词）</h2>

      <Bilingual
        label="文生图全局提示词"
        en={storyboard.globalPrompt || ''}
        zh={storyboard.globalPromptZh || ''}
        active={active.global || 'en'}
        onEn={(v) => { onChange({ globalPrompt: v }); mark('global', 'en'); }}
        onZh={(v) => { onChange({ globalPromptZh: v }); mark('global', 'zh'); }}
        rows={2}
      />

      {/* ─── 图生图参考角色 + 强制纯景 ─── */}
      <div className="opts-bar">
        <label className="toggle-label" title="强制纯景：忽略提示词中的人物描述，所有图片生成为纯风光/场景。后端已自动检测无人物 prompt 并添加排除指令，此开关仅在需手动覆盖含人物的 prompt 时使用。">
          <input type="checkbox" checked={noCharacter} onChange={(e) => setNoCharacter(e.target.checked)} disabled={busy} />
          <span>强制纯景（移除所有人物）</span>
        </label>
        <div className="ref-img-wrap">
          <label className="ref-label" title="图生图：导入角色参考图片，所有生成图片中主体角色的脸和穿着均按此图生成">
            <span>角色参考图：</span>
            <input type="file" accept="image/*" onChange={handleRefImage} disabled={busy} style={{ fontSize: '0.85rem' }} />
          </label>
          {refPreview && (
            <div className="ref-preview">
              <img src={refPreview} alt="角色参考" style={{ maxWidth: 80, maxHeight: 80, borderRadius: 6, border: '2px solid #1976d2' }} />
              <button className="small" onClick={clearRefImage} title="清除参考图" disabled={busy}>×</button>
            </div>
          )}
        </div>
      </div>

      <div className="row">
        <button className="primary" disabled={busy} onClick={batchGenerate}>
          {busy ? `生成中… (第 ${progress + 1}/${n} 张)` : '按顺序批量生成全部图片（每段冷却 10s）'}
        </button>
        <span className="count">{doneCount} / {n} 已生成</span>
      </div>

      {(busy || doneCount > 0) && (
        <ProgressBar
          value={doneCount}
          max={n}
          unit=" 张"
          label={
            busy
              ? (cooling
                  ? `冷却中（避免限流）… 已完成 ${doneCount}/${n} 张`
                  : phase && phase.startsWith('抢救')
                    ? `${phase}… 已完成 ${doneCount}/${n} 张`
                    : `正在生成第 ${progress + 1}/${n} 张…`)
              : (allDone ? '全部图片已生成 ✓' : '图片生成进度')
          }
        />
      )}

      <div className="seg-list">
        {storyboard.segments.map((seg, i) => {
          const im = images[i];
          return (
            <div className="seg" key={i}>
              <div className="seg-head">
                第 {i + 1} 镜
                {seg.cast && (
                  <span className={`cast-badge ${seg.cast.startsWith('纯景') ? 'badge-pure' : seg.cast.startsWith('群像') ? 'badge-crowd' : seg.cast.startsWith('双人') ? 'badge-duo' : 'badge-solo'}`}>
                    {seg.cast.startsWith('纯景') ? '纯景' : seg.cast.startsWith('群像') ? '群像' : seg.cast.startsWith('双人') ? '双人' : '独处'}
                  </span>
                )}
              </div>
              <div className="img-row">
                <div className="img-box">
                  {im?.url
                    ? <img src={im.url} alt={`第${i + 1}镜`}
                        onClick={() => setZoom({ url: im.url, caption: `第 ${i + 1} 镜${seg.imagePromptZh ? ' · ' + seg.imagePromptZh : ''}` })}
                        title="点击放大" />
                    : <div className="placeholder">未生成</div>}
                </div>
                <div className="img-side">
                  <Bilingual
                    label="文生图提示词"
                    en={seg.imagePrompt || ''}
                    zh={seg.imagePromptZh || ''}
                    active={active[`seg-${i}`] || 'en'}
                    onEn={(v) => { onSegmentChange(i, 'imagePrompt', v); mark(`seg-${i}`, 'en'); }}
                    onZh={(v) => { onSegmentChange(i, 'imagePromptZh', v); mark(`seg-${i}`, 'zh'); }}
                  />
                  <button className="small" disabled={busy && progress !== i}
                    onClick={() => regen(i)}>
                    {busy && progress === i ? '生成中…' : (im ? '重生成' : '生成')}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error && <div className="banner error">{error}</div>}
      {busy && backend?.detail && (
        <div className="hint proc-detail">后端：{backend.label}（{backend.detail}）</div>
      )}
      {busy && stalled && (
        <div className="banner warn">⚠️ 任务可能卡死：已超过 {Math.round(backend.stalledMs / 1000)} 秒无进度更新。可点击「← 上一步」取消。</div>
      )}

      <div className="row">
        <button className="ghost" onClick={handleBack}>← 上一步</button>
        <button className="primary" disabled={!allDone} onClick={onConfirm}>
          {allDone ? '图片确认，进入视频生成 →' : `还需生成 ${n - images.filter(Boolean).length} 张`}
        </button>
      </div>

      {zoom && (
        <Lightbox
          src={zoom.url}
          caption={zoom.caption}
          onClose={() => setZoom(null)}
        />
      )}
    </section>
  );
}
