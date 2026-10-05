import React, { useState, useRef } from 'react';
import { generateVideo, abortJob } from '../api.js';
import { runBatchWithRescue } from './runBatchWithRescue.js';
import ProgressBar from '../components/ProgressBar.jsx';
import Lightbox from '../components/Lightbox.jsx';
import { Bilingual } from '../components/Bilingual.jsx';
import useProgress from '../hooks/useProgress.js';

export default function Step4Videos({
  job, storyboard, images, videos, onChange, onSegmentChange, setVideo, onConfirm, onBack, orientation = 'landscape',
}) {
  const n = job.segments.length;
  const [zoom, setZoom] = useState(null); // 点击缩略视频放大播放
  const dirLabel = orientation === 'portrait' ? '竖屏 3:4（720×960）' : '横屏 4:3（960×720）';
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [cooling, setCooling] = useState(false);
  const [phase, setPhase] = useState(''); // '生成' | '抢救（第 X/Y 轮）' | ''
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const abortRef = useRef(null);
  const { progress: backend, stalled } = useProgress(job?.jobId, busy);

  // 记录每段提示词"最近编辑的语言"，生成时使用该语言文本（保证改中文或英文都生效）。
  const [active, setActive] = useState({});
  const activeRef = useRef(active);
  const mark = (key, lang) => setActive((p) => { const n = { ...p, [key]: lang }; activeRef.current = n; return n; });

  const doneCount = videos.filter(Boolean).length;
  const allDone = doneCount === n;

  async function generateOne(i) {
    if (!images[i]) throw new Error(`第 ${i + 1} 镜图片尚未生成`);
    const controller = new AbortController();
    abortRef.current = controller;
    // 取最近编辑的语言作为实际发送的提示词（中文或英文），两者皆可生效。
    const a = activeRef.current;
    const segLang = a[`seg-${i}`] || 'en';
    const segPrompt = segLang === 'zh' ? storyboard.segments[i].videoPromptZh : storyboard.segments[i].videoPrompt;
    const gLang = a.global || 'en';
    const gPrompt = gLang === 'zh' ? storyboard.globalVideoPromptZh : storyboard.globalVideoPrompt;
    const rec = await generateVideo(job.jobId, i, segPrompt, gPrompt, controller.signal);
    abortRef.current = null;
    // vid_xxx.mp4 文件名固定，重生成覆盖文件但 URL 不变 → 浏览器缓存旧视频。
    // 追加时间戳缓存戳，强制刷新缩略图/预览。
    const busted = `${rec.url}${rec.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    setVideo(i, { index: i, url: busted, prompt: segPrompt });
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
      await abortJob(job.jobId, false); // 进入单段重生成前清除取消标记
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
      <h2>步骤 4 · 图生视频（{dirLabel} · 按分镜顺序，可重生成 / 改提示词）</h2>

      <Bilingual
        label="图生视频全局提示词"
        en={storyboard.globalVideoPrompt || ''}
        zh={storyboard.globalVideoPromptZh || ''}
        active={active.global || 'en'}
        onEn={(v) => { onChange({ globalVideoPrompt: v }); mark('global', 'en'); }}
        onZh={(v) => { onChange({ globalVideoPromptZh: v }); mark('global', 'zh'); }}
        rows={2}
      />

      <div className="row">
        <button className="primary" disabled={busy} onClick={batchGenerate}>
          {busy ? `生成中… (第 ${progress + 1}/${n} 段)` : '按顺序批量生成全部视频（冷却避免限流）'}
        </button>
        <span className="count">{doneCount} / {n} 已生成</span>
      </div>

      {(busy || doneCount > 0) && (
        <ProgressBar
          value={doneCount}
          max={n}
          unit=" 段"
          label={
            busy
              ? (cooling
                  ? `冷却中（避免限流）… 已完成 ${doneCount}/${n} 段`
                  : phase && phase.startsWith('抢救')
                    ? `${phase}… 已完成 ${doneCount}/${n} 段`
                    : `正在生成第 ${progress + 1}/${n} 段（图生视频较慢，请耐心等待）…`)
              : (allDone ? '全部视频已生成 ✓' : '视频生成进度')
          }
        />
      )}

      <div className="seg-list">
        {storyboard.segments.map((seg, i) => {
          const v = videos[i];
          return (
            <div className="seg" key={i}>
              <div className="seg-head">第 {i + 1} 镜</div>
              <div className="img-row">
                <div
                  className="img-box video-thumb"
                  onClick={() => v?.url && setZoom({ url: v.url, caption: `第 ${i + 1} 镜${seg.videoPromptZh ? ' · ' + seg.videoPromptZh : ''}` })}
                  title="点击放大播放"
                >
                  {v?.url
                    ? <video src={v.url} muted playsInline preload="metadata" />
                    : <div className="placeholder">未生成</div>}
                  {v?.url && <span className="zoom-badge">⤢ 放大</span>}
                </div>
                <div className="img-side">
                  <Bilingual
                    label="图生视频提示词"
                    en={seg.videoPrompt || ''}
                    zh={seg.videoPromptZh || ''}
                    active={active[`seg-${i}`] || 'en'}
                    onEn={(v) => { onSegmentChange(i, 'videoPrompt', v); mark(`seg-${i}`, 'en'); }}
                    onZh={(v) => { onSegmentChange(i, 'videoPromptZh', v); mark(`seg-${i}`, 'zh'); }}
                  />
                  <button className="small" disabled={busy && progress !== i || !images[i]}
                    onClick={() => regen(i)}>
                    {busy && progress === i ? '生成中…' : (v ? '重生成' : '生成')}
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
        <div className="banner warn">⚠️ 任务可能卡死：已超过 {Math.round(backend.stalledMs / 1000)} 秒无进度更新。图生视频渲染通常较慢（数十秒到数分钟），若远超预期可点击「← 上一步」取消重试。</div>
      )}

      <div className="row">
        <button className="ghost" onClick={handleBack}>← 上一步</button>
        <button className="primary" disabled={!allDone} onClick={onConfirm}>
          {allDone ? '视频确认，进入合成 →' : `还需生成 ${n - videos.filter(Boolean).length} 段`}
        </button>
      </div>

      {zoom && (
        <Lightbox
          src={zoom.url}
          type="video"
          caption={zoom.caption}
          onClose={() => setZoom(null)}
        />
      )}
    </section>
  );
}
