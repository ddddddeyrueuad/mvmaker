import React, { useState, useEffect } from 'react';
import { uploadAudio, testAgnesKey, fetchAgnesConfig } from '../api.js';

export default function Step1Upload({ job, lyrics, setLyrics, agnesKey, setAgnesKey, agnesBase, setAgnesBase, orientation, setOrientation, onUploaded, onAnalyze }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, msg }
  const [savedKey, setSavedKey] = useState(null); // { hasKey, keyMasked, baseUrl }

  // 挂载时读取后端「已保存 Key」状态（脱敏），显示「已保存」免重复输入
  useEffect(() => {
    fetchAgnesConfig()
      .then((c) => { if (c && c.hasKey) setSavedKey(c); })
      .catch(() => {});
  }, []);

  async function doTestSave() {
    setTesting(true);
    setTestResult(null);
    try {
      // save 默认 true：测试通过后把 Key 持久化到 userData/config.env，重启免重输
      const res = await testAgnesKey(agnesKey.trim(), agnesBase.trim());
      if (res.ok) {
        setSavedKey({ hasKey: true, keyMasked: res.keyMasked, baseUrl: res.baseUrl || agnesBase.trim() });
        setAgnesKey(''); // 清空明文输入框（已保存）
        setTestResult({ ok: true, msg: `✓ Key 有效已保存（${res.model}，${res.latencyMs}ms）。以后无需再次输入。` });
      } else {
        setTestResult({ ok: false, msg: res.error || 'Key 测试失败' });
      }
    } finally {
      setTesting(false);
    }
  }

  async function doUpload() {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const data = await uploadAudio(file, agnesKey, agnesBase, orientation);
      onUploaded(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  async function doAnalyze() {
    setAnalyzing(true);
    setError('');
    try {
      await onAnalyze(lyrics);
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  }

  if (!job) {
    return (
      <section className="panel">
        <h2>步骤 1 · 上传音频</h2>
        <p className="hint">支持 mp3 / flac / wav 等主流格式。系统将按 10 秒自动切片，切片数量即分镜数量。</p>

        <h3>Agnes API 配置（测试通过后自动保存，重启免重复输入）</h3>
        <label className="field">
          <span className="field-label">API Key（Bearer）</span>
          <input type="password" className="kv"
            placeholder="粘贴你的 Agnes API Key"
            value={agnesKey} onChange={(e) => { setAgnesKey(e.target.value); setTestResult(null); }} />
        </label>
        <label className="field">
          <span className="field-label">Base URL</span>
          <input type="text" className="kv" value={agnesBase} onChange={(e) => setAgnesBase(e.target.value)} />
        </label>
        <div className="row">
          <button className="ghost" disabled={testing || !agnesKey.trim()} onClick={doTestSave}>
            {testing ? '测试中…' : '测试并保存 Key'}
          </button>
        </div>
        {testResult && (
          <div className={`banner ${testResult.ok ? 'success' : 'error'}`}>
            {testResult.ok ? '🟢 ' : '❌ '}{testResult.msg}
          </div>
        )}
        {savedKey?.hasKey && (
          <div className="banner success">
            🟢 已保存 Key（{savedKey.keyMasked}），上传后自动调用真实 Agnes，无需再次输入
          </div>
        )}
        <div className={`banner ${agnesKey.trim() || savedKey?.hasKey ? 'success' : 'warn'}`}>
          {agnesKey.trim()
            ? '🟢 将使用输入框中的 Key 调用真实 Agnes（建议先「测试并保存 Key」）'
            : (savedKey?.hasKey
                ? '🟢 使用已保存的 Key 调用真实 Agnes'
                : '🔴 未配置 Agnes API Key：必须先配置 Key 才能生成（已取消 Mock 降级，未配置将报错中断）')}
        </div>

        <h3>画面方向（图片与视频分辨率）</h3>
        <div className="row orientation">
          <label className={`pill ${orientation === 'landscape' ? 'on' : ''}`}>
            <input type="radio" name="orient" checked={orientation === 'landscape'} onChange={() => setOrientation('landscape')} />
            横屏 4:3（1792×1024 图 / 960×720 视频）
          </label>
          <label className={`pill ${orientation === 'portrait' ? 'on' : ''}`}>
            <input type="radio" name="orient" checked={orientation === 'portrait'} onChange={() => setOrientation('portrait')} />
            竖屏 3:4（1024×1792 图 / 720×960 视频）
          </label>
        </div>

        <input
          type="file"
          accept="audio/*,.mp3,.flac,.wav,.ogg,.m4a"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />
        <div className="row">
          <button className="primary" disabled={!file || uploading} onClick={doUpload}>
            {uploading ? '上传中…' : '上传音频'}
          </button>
          {file && <span className="filename">{file.name}</span>}
        </div>
        {error && <div className="banner error">{error}</div>}
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>步骤 1 · 已上传</h2>
      <div className="card">
        <div><b>文件名：</b>{job.audio?.originalName}</div>
        <div><b>时长：</b>{job.audio?.duration?.toFixed(2)} 秒</div>
        <div><b>切片数（=分镜数）：</b>{job.segments?.length} 段（每段 10 秒）</div>
      </div>

      <h3>可选 · 填入歌词（将融合音乐风格生成分镜）</h3>
      <textarea
        className="lyrics"
        placeholder="把歌词粘贴到这里（每行一句）。留空则仅按音乐风格创作。"
        value={lyrics}
        onChange={(e) => setLyrics(e.target.value)}
      />

      <div className="row">
        <button className="primary" disabled={analyzing} onClick={doAnalyze}>
          {analyzing ? '正在分析并生成分镜…' : '生成分镜脚本 →'}
        </button>
      </div>
      {error && <div className="banner error">{error}</div>}
    </section>
  );
}
