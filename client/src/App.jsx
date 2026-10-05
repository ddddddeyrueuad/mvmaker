import React, { useState } from 'react';
import Step1Upload from './steps/Step1Upload.jsx';
import Step2Storyboard from './steps/Step2Storyboard.jsx';
import Step3Images from './steps/Step3Images.jsx';
import Step4Videos from './steps/Step4Videos.jsx';
import Step5Compose from './steps/Step5Compose.jsx';
import LogConsole from './components/LogConsole.jsx';
import StoryProgress from './components/StoryProgress.jsx';
import ProgressBar from './components/ProgressBar.jsx';
import useProgress from './hooks/useProgress.js';
import { uploadAudio, generateStoryboard, fetchJob } from './api.js';

const STEPS = ['上传音频', '分镜脚本', '文生图', '图生视频', '合成 MV'];

export default function App() {
  const [step, setStep] = useState(1);
  const [job, setJob] = useState(null); // {jobId, duration, segments, audio}
  const [agnesKey, setAgnesKey] = useState('');
  const [agnesBase, setAgnesBase] = useState('https://api.agnes-ai.cn/v1');
  const [lyrics, setLyrics] = useState('');
  const [orientation, setOrientation] = useState('landscape');
  const [analysis, setAnalysis] = useState(null);
  const [storyboard, setStoryboard] = useState(null);
  const [images, setImages] = useState([]);
  const [videos, setVideos] = useState([]);
  const [finalMv, setFinalMv] = useState(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const updateStoryboard = (patch) => setStoryboard((s) => ({ ...s, ...patch }));
  const updateSegment = (i, field, value) =>
    setStoryboard((s) => {
      const segments = s.segments.map((seg, idx) => (idx === i ? { ...seg, [field]: value } : seg));
      return { ...s, segments };
    });

  async function handleUploaded(data) {
    setJob(data);
    setOrientation(data.orientation || 'landscape');
    setError('');
  }

  async function handleAnalyze(lyricsText) {
    if (!job) return;
    setStatus('正在用 mert 分析音频…（分镜脚本将在选定画风后生成）');
    setError('');
    setAnalyzing(true);
    try {
      const res = await generateStoryboard(job.jobId, lyricsText);
      setAnalysis(res.analysis);
      setStoryboard(res.storyboard || null); // 此阶段仅分析，分镜为空，待 Step2 选画风后生成
      setStep(2);
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus('');
      setAnalyzing(false);
    }
  }

  function setImage(i, rec) {
    setImages((arr) => {
      const next = [...arr];
      next[i] = rec;
      return next;
    });
  }
  function setVideo(i, rec) {
    setVideos((arr) => {
      const next = [...arr];
      next[i] = rec;
      return next;
    });
  }

  async function restore(jobId) {
    try {
      const j = await fetchJob(jobId);
      setJob({ jobId, duration: j.audio?.duration, segments: j.segments, audio: j.audio, orientation: j.orientation });
      setOrientation(j.orientation || 'landscape');
      setLyrics(j.lyrics || '');
      setAnalysis(j.analysis);
      setStoryboard(j.storyboard);
      setImages(j.images || []);
      setVideos(j.videos || []);
      setFinalMv(j.finalMv || null);
      setStep(j.finalMv ? 5 : j.videos?.length ? 4 : j.images?.length ? 3 : (j.storyboard || j.analysis) ? 2 : 1);
    } catch (e) {
      setError(e.message);
    }
  }

  // 一键重置：清空当前任务所有数据，回到"上传音频"首页面。
  // 必须 setJob(null) —— 否则 Step1Upload 会停在"已上传"分支（无重新上传入口），用户只能重启软件。
  function resetAll() {
    setStep(1);
    setJob(null);
    setLyrics('');
    setAnalysis(null);
    setStoryboard(null);
    setImages([]);
    setVideos([]);
    setFinalMv(null);
    setStatus('');
    setError('');
    // 保留 agnesKey / agnesBase / orientation 等用户偏好配置
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>🎬 MV 自动生成工坊</h1>
        <p className="sub">音频切片 → mert 分析 → agnes 分镜/文生图/图生视频 → ffmpeg 合成</p>
      </header>

      <nav className="stepper">
        {STEPS.map((label, i) => {
          const n = i + 1;
          return (
            <div key={label} className={`step ${n === step ? 'active' : ''} ${n < step ? 'done' : ''}`}>
              <span className="num">{n}</span>
              <span className="lbl">{label}</span>
            </div>
          );
        })}
      </nav>

      {status && <div className="banner info">⏳ {status}</div>}
      {analyzing && job && <StoryProgress jobId={job.jobId} />}
      {error && <div className="banner error">❌ {error}</div>}
      {finalMv && <div className="banner success">✅ MV 已生成，可在最后一步预览下载</div>}

      <div className="layout">
        <main className="content">
          {step === 1 && (
            <Step1Upload
              job={job}
              lyrics={lyrics}
              setLyrics={setLyrics}
              agnesKey={agnesKey}
              setAgnesKey={setAgnesKey}
              agnesBase={agnesBase}
              setAgnesBase={setAgnesBase}
              orientation={orientation}
              setOrientation={setOrientation}
              onUploaded={handleUploaded}
              onAnalyze={handleAnalyze}
            />
          )}
          {step === 2 && analysis && (
            <Step2Storyboard
              jobId={job.jobId}
              storyboard={storyboard}
              setStoryboard={setStoryboard}
              analysis={analysis}
              segCount={job.segments.length}
              onChange={updateStoryboard}
              onSegmentChange={updateSegment}
              onConfirm={() => setStep(3)}
              onBack={() => setStep(1)}
            />
          )}
          {step === 3 && storyboard && (
            <Step3Images
              job={job}
              storyboard={storyboard}
              images={images}
              orientation={orientation}
              onChange={updateStoryboard}
              onSegmentChange={updateSegment}
              setImage={setImage}
              onConfirm={() => setStep(4)}
              onBack={() => setStep(2)}
            />
          )}
          {step === 4 && storyboard && (
            <Step4Videos
              job={job}
              storyboard={storyboard}
              images={images}
              videos={videos}
              orientation={orientation}
              onChange={updateStoryboard}
              onSegmentChange={updateSegment}
              setVideo={setVideo}
              onConfirm={() => setStep(5)}
              onBack={() => setStep(3)}
            />
          )}
          {step === 5 && (
            <Step5Compose
              job={job}
              finalMv={finalMv}
              setFinalMv={setFinalMv}
              onBack={() => setStep(4)}
              onRestart={resetAll}
            />
          )}
        </main>

        {job && (
          <aside className="log-side">
            <LogConsole jobId={job.jobId} />
          </aside>
        )}
      </div>

      <footer className="foot">
        <span>任务 ID：{job?.jobId || '—'}</span>
        {job && (
          <>
            <button className="link" onClick={() => restore(job.jobId)}>
              刷新/恢复该任务状态
            </button>
            <button className="link" onClick={resetAll}>
              🏠 重新制作（返回上传音频首页）
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
