import express from 'express';
import multer from 'multer';
import cors from 'cors';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, resolveAgnes, mediaSizes, saveAgnesConfig, agnesConfigSummary } from './config.js';
import * as store from './store.js';
import { sliceAudio, ensureJobDir } from './services/audio.js';
import { analyzeAudio } from './services/mert.js';
import { generateStoryboard, applyStylesToStoryboard } from './services/storyboard.js';
import { recommendStyles, STYLE_CATALOG } from './services/styles.js';
import { generateImage } from './services/t2i.js';
import { generateVideo } from './services/i2v.js';
import { composeMV } from './services/compose.js';
import { log, getLogs } from './logger.js';
import { makeRunTag, ensureOutputDirs, saveReport, copyClipArtifact, copyFinal } from './utils/outputDirs.js';
import { beginProgress, setProgress, endProgress, getProgress } from './progress.js';

/**
 * 修复上传文件名乱码：某些客户端会把 UTF-8 文件名以 Latin-1 误读后再编码，
 * 表现如 "纯音乐长笛.mp3" → "çº¯é³éä¹é¿¬ç¬·.mp3"。
 * 若按 latin1 重新解码能得到合法中文，则采用修复后的名称。
 */
function fixMojibake(name) {
  if (!name) return name;
  const repaired = Buffer.from(name, 'latin1').toString('utf8');
  if (repaired !== name && /[一-鿿]/.test(repaired)) return repaired;
  return name;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// 请求级日志：每个 API 调用都打印到后端控制台（配合 logger 的详细分步日志）
app.use((req, res, next) => {
  const t0 = Date.now();
  const jobId = req.body?.jobId || req.query?.jobId || '-';
  console.log(`[REQ] ${req.method} ${req.path} job=${jobId}`);
  res.on('finish', () => {
    const ms = Date.now() - t0;
    console.log(`[RES] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

const uploads = config.paths.uploads;
fs.mkdirSync(uploads, { recursive: true });

/** 把服务器内绝对路径转换为 /files/... 的访问 URL */
function fileUrl(filePath) {
  const rel = path.relative(uploads, filePath).split(path.sep).join('/');
  return `/files/${rel}`;
}
function jobDirOf(jobId) {
  return path.join(uploads, jobId);
}

/** 序列化 job 给前端（路径 → URL） */
function serialize(job, id) {
  if (!job) return null;
  const jid = id || job.id || null;
  return {
    ...job,
    id: jid,
    audio: job.audio ? { ...job.audio, url: fileUrl(job.audio.path) } : null,
    images: (job.images || []).map((im) => ({ ...im, url: fileUrl(im.path) })),
    videos: (job.videos || []).map((v) => ({ ...v, url: fileUrl(v.path) })),
    finalMv: job.finalMv ? { ...job.finalMv, url: fileUrl(job.finalMv.path) } : null,
    logs: getLogs(jid).logs,
  };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// 静态文件：生成的产物
app.use('/files', express.static(uploads));

// 生产环境：托管前端构建产物（路径可由 CLIENT_DIST 覆盖，Electron 打包后指向随包 dist）
const clientDist = config.paths.clientDist;
if (fs.existsSync(clientDist)) app.use(express.static(clientDist));

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  agnes: Boolean(config.agnes.baseUrl && config.agnes.apiKey),
  mertLocal: config.mert.local,
  mertMode: config.mert.remoteUrl ? 'remote' : (config.mert.local ? 'local' : 'auto'),
}));

// 读取「已保存的 Agnes 配置」（脱敏）。前端据此判断是否已有 Key、无需再次输入。
app.get('/api/agnes/config', (_req, res) => res.json(agnesConfigSummary()));

// 测试 Agnes API Key（真实 chat ping）。成功可选持久化保存到 .env + 运行内存。
// body: { apiKey?, baseUrl?, save?=true }。apiKey 留空则测试「已保存的 Key」。
app.post('/api/agnes/test', async (req, res) => {
  try {
    const rawKey = String(req.body.apiKey || '').trim();
    const rawBase = String(req.body.baseUrl || '').trim();
    const save = req.body.save !== false;

    const apiKey = rawKey || config.agnes.apiKey;
    const baseUrl = (rawBase || config.agnes.baseUrl || '').replace(/\/+$/, '');
    if (!apiKey) return res.json({ ok: false, error: '未提供 API Key，且没有已保存的 Key。' });
    if (!baseUrl) return res.json({ ok: false, error: '未提供 Base URL。' });

    const host = baseUrl.replace(/\/v1$/, '');
    const url = host + config.agnes.chatPath;
    const headers = config.agnes.authType === 'x-api-key'
      ? { 'X-API-Key': apiKey, 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    const t0 = Date.now();
    try {
      await axios.post(url, {
        model: config.agnes.chatModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        stream: false,
      // agnes-2.5-flash 为推理模型，实测单次 chat 需 9~28s（reasoning 占输出预算），
      // 20s 超时曾误报「timeout of 20000ms exceeded」，提到 60s 稳妥。
      }, { headers, timeout: 60000 });
    } catch (e) {
      const status = e.response?.status;
      let msg;
      if (status === 401 || status === 403) msg = `鉴权失败（HTTP ${status}）：API Key 无效或已过期，请检查是否粘贴完整。`;
      else if (status === 404) msg = `接口不存在（HTTP 404）：请检查 Base URL 是否正确（当前 ${host}）。`;
      else if (status === 429) msg = 'Key 有效，但触发限流（HTTP 429）：调用过于频繁或额度耗尽，请稍后再试。';
      else if (status) msg = `Agnes 返回 HTTP ${status}：${JSON.stringify(e.response?.data || '').slice(0, 200)}`;
      else msg = `网络错误：${e.message}`;
      log(null, 'warn', 'agnes', `Key 测试失败：${msg}`);
      return res.json({ ok: false, status: status || 0, error: msg });
    }

    // 测试通过：按需持久化（保存到 userData/config.env，重启后仍可用）
    let saved = false;
    if (save && (rawKey || rawBase)) {
      saveAgnesConfig({ apiKey: rawKey || undefined, baseUrl: rawBase || undefined });
      saved = true;
      log(null, 'info', 'agnes', `Key 测试通过并已保存（${config.agnes.chatModel}）。`);
    } else {
      log(null, 'info', 'agnes', `已保存的 Key 测试通过（${config.agnes.chatModel}）。`);
    }
    const summary = agnesConfigSummary();
    res.json({ ok: true, saved, model: config.agnes.chatModel, latencyMs: Date.now() - t0, ...summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 步骤1：上传音频并切片
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到音频文件' });
    const ext = path.extname(req.file.originalname) || '.wav';
    const originalName = fixMojibake(req.file.originalname);
    const jobId = randomUUID();
    // 本次任务的归档命名标签：音频名(去扩展名) + 时间戳，贯穿 report/temp clip/output 三处。
    const runTag = makeRunTag(originalName);
    ensureOutputDirs();
    const jobDir = ensureJobDir(jobDirOf(jobId));
    const audioPath = path.join(jobDir, `original${ext}`);
    fs.writeFileSync(audioPath, req.file.buffer);

    const { duration, segments } = await sliceAudio(audioPath, jobDir);
    const orientation = (req.body.orientation || config.output.orientation) === 'portrait' ? 'portrait' : 'landscape';
    const sz = mediaSizes(orientation);
    log(jobId, 'info', 'upload', `音频已上传：${originalName}（${duration.toFixed(2)}s，切片 ${segments.length} 段）`);
    log(jobId, 'info', 'upload', `画面方向：${orientation === 'portrait' ? '竖屏 3:4' : '横屏 4:3'}（图片 ${sz.image.width}x${sz.image.height}，视频 ${sz.video.width}x${sz.video.height}）`);
    const job = store.createJob(jobId, {
      audio: { originalName, path: audioPath, duration, ext },
      runTag,
      orientation,
      agnes: req.body.apiKey
        ? { apiKey: req.body.apiKey, baseUrl: (req.body.baseUrl || '').replace(/\/+$/, '') || config.agnes.baseUrl }
        : (config.agnes.enabled ? { apiKey: config.agnes.apiKey, baseUrl: config.agnes.baseUrl } : null),
      segments,
      lyrics: null,
      analysis: null,
      storyboard: null,
      images: [],
      videos: [],
      finalMv: null,
    });
    res.json({ jobId, duration, segments, orientation, audio: serialize(job, jobId).audio });
  } catch (e) {
    log(null, 'error', 'upload', `上传失败：${e.stack || e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 步骤2-A：仅 mert 音频分析（不生成分镜）。
// 视觉设定集 / 全局提示词 / 分镜提示词必须等用户在 Step2 选定画风后，
// 由 /api/storyboard/regenerate 按所选画风生成，避免先用默认电影风格生成再改画风带来的残留。
app.post('/api/storyboard', async (req, res) => {
  const { jobId, lyrics } = req.body || {};
  try {
    const job = store.getJob(jobId);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    job.lyrics = lyrics || null;
    beginProgress(jobId, 'storyboard', 'MERT 音频分析中…');
    const analysis = await analyzeAudio(job.audio.path, job.segments, jobId, (p) => {
      // 仅音频分析：MERT 内部进度 0-100 → 整体 0-100%
      setProgress(jobId, { percent: (p.percent || 0), label: p.label || 'MERT 音频分析中…', detail: `MERT 逐段 ${p.done ?? ''}/${p.total ?? ''}` });
    });
    // 只保存分析结果；分镜脚本置空，等待用户选定画风后再生成
    job.analysis = analysis;
    job.storyboard = null;
    job.baseStoryboard = null;
    job.styleIds = [];
    store.updateJob(jobId, { analysis, storyboard: null, baseStoryboard: null, styleIds: [], lyrics: job.lyrics });
    log(jobId, 'info', 'storyboard', `音频分析完成，等待用户选择画风后再生成分镜（流派=${analysis?.overall?.genre || '?'}，BPM≈${analysis?.overall?.tempoBpm ?? '?'}）`);
    endProgress(jobId, true, '音频分析完成，请选择画风后生成分镜 ✓');
    res.json({ analysis, storyboard: null });
  } catch (e) {
    log(jobId, 'error', 'storyboard', `音频分析失败：${e.stack || e.message}`);
    endProgress(jobId, false, `音频分析失败：${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 步骤3：生成/重生成单张分镜图
app.post('/api/images/generate-one', async (req, res) => {
  const { jobId, index, imagePrompt, globalPrompt, noCharacter, referenceImage } = req.body || {};
  try {
    const job = store.getJob(jobId);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (job.aborted) return res.status(409).json({ error: '任务已取消' });
    if (!job.storyboard) return res.status(400).json({ error: '请先生成分镜脚本' });
    const i = Number(index);
    const total = job.segments.length;
    const doneSoFar = (job.images || []).filter(Boolean).length;
    beginProgress(jobId, 'image', `文生图 第${i + 1}/${total}张…`, `已完成 ${doneSoFar}/${total} 张`);
    const outName = `img_${String(i + 1).padStart(3, '0')}.png`;
    const outPath = path.join(jobDirOf(jobId), outName);
    setProgress(jobId, { percent: Math.round((doneSoFar / total) * 100), label: `文生图 第${i + 1}/${total}张…`, detail: `请求 agnes t2i(${resolveAgnes(job.agnes).t2iModel})` });
    const segMeta = (job.storyboard.segments && job.storyboard.segments[i]) || {};
    const charLock = job.storyboard.characterLock || '';
    await generateImage(outPath, imagePrompt, globalPrompt || job.storyboard.globalPrompt || '', i, resolveAgnes(job.agnes), jobId, job.orientation, resolveAgnes(job.agnes).imageNegativePrompt || '', noCharacter, referenceImage, job.styleIds || [], segMeta.shotSize || '', charLock);
    const rec = { index: i, prompt: imagePrompt, path: outPath };
    job.images = job.images || [];
    job.images[i] = rec;
    store.updateJob(jobId, { images: job.images });
    // 归档：分镜图片 → temp clip/<runTag>/<同名文件>
    if (!job.runTag) { job.runTag = makeRunTag(job.audio?.originalName); store.updateJob(jobId, { runTag: job.runTag }); }
    const cf = copyClipArtifact(job.runTag, outName, outPath);
    if (cf) log(jobId, 'info', 'clip', `分镜图片已归档：${cf}`);
    endProgress(jobId, true, `图片 ${i + 1}/${total} 生成完成 ✓`);
    res.json({ index: i, url: fileUrl(outPath), path: outPath });
  } catch (e) {
    log(jobId, 'error', 'image', `图片生成失败（第${Number(index) + 1}镜）：${e.stack || e.message}`);
    endProgress(jobId, false, `图片生成失败：${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 步骤4：生成/重生成单段视频
app.post('/api/videos/generate-one', async (req, res) => {
  const { jobId, index, videoPrompt, globalVideoPrompt } = req.body || {};
  try {
    const job = store.getJob(jobId);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (job.aborted) return res.status(409).json({ error: '任务已取消' });
    const i = Number(index);
    const total = job.segments.length;
    const doneSoFar = (job.videos || []).filter(Boolean).length;
    const img = job.images?.[i];
    if (!img) return res.status(400).json({ error: '该分镜图片尚未生成' });
    beginProgress(jobId, 'video', `图生视频 第${i + 1}/${total}段…`, `已完成 ${doneSoFar}/${total} 段`);
    const outName = `vid_${String(i + 1).padStart(3, '0')}.mp4`;
    const outPath = path.join(jobDirOf(jobId), outName);
    setProgress(jobId, { percent: Math.round((doneSoFar / total) * 100), label: `图生视频 第${i + 1}/${total}段…`, detail: `提交 agnes i2v(${resolveAgnes(job.agnes).i2vModel})` });
    await generateVideo(outPath, img.path, videoPrompt, globalVideoPrompt || job.storyboard?.globalVideoPrompt || '', i, resolveAgnes(job.agnes), jobId, job.orientation, resolveAgnes(job.agnes).videoNegativePrompt || '');
    const rec = { index: i, prompt: videoPrompt, path: outPath };
    job.videos = job.videos || [];
    job.videos[i] = rec;
    store.updateJob(jobId, { videos: job.videos });
    // 归档：视频片段 → temp clip/<runTag>/<同名文件>
    if (!job.runTag) { job.runTag = makeRunTag(job.audio?.originalName); store.updateJob(jobId, { runTag: job.runTag }); }
    const cf = copyClipArtifact(job.runTag, outName, outPath);
    if (cf) log(jobId, 'info', 'clip', `视频片段已归档：${cf}`);
    endProgress(jobId, true, `视频 ${i + 1}/${total} 生成完成 ✓`);
    res.json({ index: i, url: fileUrl(outPath), path: outPath });
  } catch (e) {
    log(jobId, 'error', 'video', `视频生成失败（第${Number(index) + 1}镜）：${e.stack || e.message}`);
    endProgress(jobId, false, `视频生成失败：${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 步骤5：合成 MV
app.post('/api/compose', async (req, res) => {
  const { jobId } = req.body || {};
  try {
    const job = store.getJob(jobId);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    const videos = (job.videos || []).filter(Boolean).map((v) => v.path);
    if (videos.length < job.segments.length) {
      return res.status(400).json({ error: `还有 ${job.segments.length - videos.length} 段视频未生成` });
    }
    const outPath = path.join(jobDirOf(jobId), 'mv_final.mp4');
    beginProgress(jobId, 'compose', '合成最终 MV…');
    await composeMV(jobDirOf(jobId), videos, job.audio.path, outPath, jobId, job.orientation);
    endProgress(jobId, true, 'MV 合成完成 ✓');
    job.finalMv = { path: outPath };
    store.updateJob(jobId, { finalMv: job.finalMv });
    // 归档：最终成品 MV → output/<runTag>.mp4
    if (!job.runTag) { job.runTag = makeRunTag(job.audio?.originalName); store.updateJob(jobId, { runTag: job.runTag }); }
    const of = copyFinal(job.runTag, outPath);
    if (of) log(jobId, 'info', 'output', `成品视频已归档：${of}`);
    res.json({ url: fileUrl(outPath), path: outPath });
  } catch (e) {
    log(jobId, 'error', 'compose', `MV 合成失败：${e.stack || e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 取消/恢复当前任务（前端"返回上一步"时停止正在进行的生成）
app.post('/api/job/:id/abort', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  job.aborted = Boolean(req.body?.abort);
  store.updateJob(req.params.id, { aborted: job.aborted });
  log(req.params.id, 'info', 'system', job.aborted ? '已请求取消当前任务' : '已恢复任务（取消标记已清除）');
  res.json({ ok: true, aborted: job.aborted });
});

// 获取画风目录 + 基于音乐/歌词分析的推荐
app.get('/api/job/:id/styles', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  const recommended = recommendStyles(job.analysis, job.lyrics);
  res.json({ catalog: STYLE_CATALOG, recommended, selected: job.styleIds || [] });
});

// 把选中画风注入已有分镜的提示词（即时生效，不重跑 LLM）
app.post('/api/storyboard/apply-style', (req, res) => {
  try {
    const { jobId, styleIds } = req.body;
    const job = store.getJob(jobId);
    if (!job || !job.storyboard) return res.status(400).json({ error: '请先生成分镜脚本' });
    const board = applyStylesToStoryboard(job.baseStoryboard || job.storyboard, styleIds || []);
    job.styleIds = styleIds || [];
    job.storyboard = board;
    store.updateJob(jobId, { storyboard: board, styleIds: job.styleIds });
    const rf = saveReport(job);
    if (rf) log(jobId, 'info', 'report', `分析报告已更新：${rf}`);
    log(jobId, 'info', 'storyboard', `已将画风注入分镜提示词（${styleIds?.length || 0} 个）`);
    res.json({ storyboard: board });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 步骤2-B：用户选定画风后，按所选画风生成 / 重新生成分镜（重跑 LLM，风格最一致）。
// 这是「视觉设定集 / 全局提示词 / 分镜提示词」的唯一生成入口——必须带上用户选定的画风。
app.post('/api/storyboard/regenerate', async (req, res) => {
  const jid = req.body?.jobId;
  try {
    const { jobId, styleIds } = req.body;
    const job = store.getJob(jobId);
    if (!job) return res.status(404).json({ error: '任务不存在' });
    if (!job.analysis) return res.status(400).json({ error: '请先完成音频分析' });
    if (!Array.isArray(styleIds) || styleIds.length === 0) {
      return res.status(400).json({ error: '请先选择画风，再生成分镜脚本' });
    }
    const agnes = resolveAgnes(job.agnes);
    const segCount = job.segments.length;
    beginProgress(jobId, 'storyboard', '按所选画风生成分镜脚本（调用 Agnes LLM）…');
    log(jobId, 'info', 'storyboard', `按用户选定画风生成分镜（${styleIds.length} 个画风）…`);
    // 关键修复（跨风格污染根因）：必须把用户选定的 styleIds 传给 generateStoryboard，
    // 让 styleInstruction(styleIds) 在「生成阶段」就把画风约束写进系统提示词（源头白名单），
    // 而不是等 LLM 按默认电影感生成后再靠 applyStylesToStoryboard 黑名单剥离兜底。
    // 之前这里传 null → LLM 收不到画风约束 → 按默认 cinematic 生成 → 选 A 仍出现电影感等 B 风格残留。
    const base = await generateStoryboard(job.analysis, job.lyrics, segCount, agnes, jobId, styleIds);
    // 生成后统一注入画风（无论 LLM 是否坍缩，都保证画风进入全局/分段提示词与 Visual Bible，并剥离默认电影风格残留）
    const storyboard = applyStylesToStoryboard(base, styleIds);
    job.baseStoryboard = base; // 存基版，供后续"即时切换画风"从基版重注入
    job.storyboard = storyboard;
    job.styleIds = styleIds;
    store.updateJob(jobId, { storyboard, baseStoryboard: base, styleIds });
    if (!job.runTag) { job.runTag = makeRunTag(job.audio?.originalName); store.updateJob(jobId, { runTag: job.runTag }); }
    const rf = saveReport(job);
    if (rf) log(jobId, 'info', 'report', `分析报告已保存：${rf}`);
    endProgress(jobId, true, '分镜脚本已按所选画风生成 ✓');
    res.json({ storyboard });
  } catch (e) {
    log(jid, 'error', 'storyboard', `按画风生成分镜失败：${e.stack || e.message}`);
    endProgress(jid, false, `分镜生成失败：${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 查询任务状态
app.get('/api/job/:id', (req, res) => {
  const job = store.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(serialize(job, req.params.id));
});

// 增量拉取处理日志（前端轮询，since=上次 nextSince）
app.get('/api/job/:id/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(getLogs(req.params.id, since));
});

// 当前处理进度（百分比 + 阶段 + 详情 + 卡死判断 stalledMs）
app.get('/api/job/:id/progress', (req, res) => {
  res.json(getProgress(req.params.id));
});

// 全局兜底错误
app.use((err, _req, res, _next) => {
  log(null, 'error', 'system', `未捕获异常：${err.stack || err.message}`);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

const port = config.port;
app.listen(port, () => {
  // 启动时从磁盘恢复历史任务（重启后端不再丢失进行中的任务）
  try { store.loadJobsOnStartup(); } catch (e) { console.warn('[store] 恢复任务失败：' + e.message); }
  const def = mediaSizes(config.output.orientation);
  console.log(`[mv-maker] 后端已启动 http://localhost:${port}`);
  console.log(`  agnes: ${Boolean(config.agnes.baseUrl && config.agnes.apiKey) ? '已配置(真实)' : '未配置(需配置才能生成，不再降级 mock)'}`);
  console.log(`  mert : ${config.mert.remoteUrl ? '远程分析(' + config.mert.remoteUrl + ')' : (config.mert.local ? '本地推理(已启用)' : '未配置(运行时探测 8791，失败将报错，不再降级 mock)')}`);
  console.log(`  默认画面方向：${config.output.orientation === 'portrait' ? '竖屏 3:4' : '横屏 4:3'}（图片 ${def.image.width}x${def.image.height} / 视频 ${def.video.width}x${def.video.height}，帧数 ${config.agnes.videoNumFrames}、${config.agnes.videoFrameRate}fps）`);
  console.log(`  归档目录：report=${config.paths.report} | temp clip=${config.paths.tempClip} | output=${config.paths.output}`);
  console.log(`  后端已启用详细分步日志（控制台实时输出，前缀 [INFO]/[WARN]/[ERROR] 及 [REQ]/[RES] 请求日志）`);
});
