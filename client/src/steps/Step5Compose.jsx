import React, { useState } from 'react';
import { compose } from '../api.js';
import ProgressBar from '../components/ProgressBar.jsx';
import Lightbox from '../components/Lightbox.jsx';
import useProgress from '../hooks/useProgress.js';

export default function Step5Compose({ job, finalMv, setFinalMv, onBack, onRestart }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(null); // 点击最终 MV 放大播放
  const { progress, stalled } = useProgress(job?.jobId, busy);

  async function doCompose() {
    setBusy(true);
    setError('');
    try {
      const res = await compose(job.jobId);
      setFinalMv({ url: res.url });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>步骤 5 · 合成 MV</h2>
      <p className="hint">
        所有视频将统一宽高比、按分镜顺序拼接，并与原始无损音频（48k）对齐合成为最终 MV。
      </p>

      <div className="row">
        <button className="primary" disabled={busy} onClick={doCompose}>
          {busy ? '合成中…' : '合成最终 MV'}
        </button>
      </div>

      {busy && (
        <ProgressBar
          percent={progress ? progress.percent : 0}
          label={progress?.label || '正在用 ffmpeg 拼接视频并对齐音频，请稍候…'}
          detail={progress?.detail}
          warn={stalled}
        />
      )}
      {busy && stalled && (
        <div className="banner warn">
          ⚠️ 合成可能卡死：已超过 {Math.round(progress.stalledMs / 1000)} 秒无进度更新。可点击「← 上一步」取消并查看右侧日志。
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      {finalMv?.url && (
        <div className="final">
          <h3>🎉 最终 MV</h3>
          <div className="final-video-wrap" title="点击放大播放">
            <video src={finalMv.url} controls className="final-video" />
            <span className="zoom-badge" onClick={() => setZoom({ url: finalMv.url, caption: '最终 MV' })}>⤢ 放大</span>
          </div>
          <div className="row">
            <a className="primary" href={finalMv.url} download="mv_final.mp4">下载 MV</a>
            {onRestart && (
              <button className="ghost" onClick={onRestart}>🏠 重新制作（返回上传音频）</button>
            )}
          </div>
        </div>
      )}

      {zoom && (
        <Lightbox
          src={zoom.url}
          type="video"
          caption={zoom.caption}
          onClose={() => setZoom(null)}
        />
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="ghost" onClick={onBack}>← 上一步</button>
        {onRestart && (
          <button className="ghost" onClick={onRestart}>🏠 重新制作</button>
        )}
      </div>
    </section>
  );
}
