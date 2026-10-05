const BASE = '';

export const COOLDOWN_MS = 15000; // 生成之间的冷却时间（15秒，agnes 视频模型免费用户 RPM=1，需谨慎）

async function post(url, body, isForm = false, signal = null) {
  const opt = isForm
    ? { method: 'POST', body, signal }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
  const r = await fetch(BASE + url, opt);
  if (r.status === 409) throw new Error('已取消');
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败 ${r.status}`);
  return data;
}

export function uploadAudio(file, apiKey, baseUrl, orientation = 'landscape') {
  const fd = new FormData();
  fd.append('audio', file);
  if (apiKey) fd.append('apiKey', apiKey);
  if (baseUrl) fd.append('baseUrl', baseUrl);
  fd.append('orientation', orientation);
  return post('/api/upload', fd, true);
}

export function generateStoryboard(jobId, lyrics) {
  return post('/api/storyboard', { jobId, lyrics });
}

/** 读取后端已保存的 Agnes 配置（脱敏）：{ hasKey, keyMasked, baseUrl } */
export async function fetchAgnesConfig() {
  try {
    const r = await fetch(BASE + '/api/agnes/config');
    return await r.json();
  } catch {
    return { hasKey: false, keyMasked: '', baseUrl: '' };
  }
}

/**
 * 测试并（成功时）保存 Agnes API Key。
 * apiKey 留空 → 测试后端已保存的 Key。返回 { ok, saved?, error?, keyMasked?, baseUrl?, latencyMs? }
 */
export async function testAgnesKey(apiKey, baseUrl, save = true) {
  try {
    const r = await fetch(BASE + '/api/agnes/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, baseUrl, save }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: `无法连接后端：${e.message}` };
  }
}

export function generateImage(jobId, index, imagePrompt, globalPrompt, signal = null, opts = {}) {
  return post('/api/images/generate-one', {
    jobId, index, imagePrompt, globalPrompt,
    noCharacter: opts.noCharacter || false,
    referenceImage: opts.referenceImage || null,
  }, false, signal);
}

export function generateVideo(jobId, index, videoPrompt, globalVideoPrompt, signal = null) {
  return post('/api/videos/generate-one', { jobId, index, videoPrompt, globalVideoPrompt }, false, signal);
}

/** 取消 / 恢复任务（abort=true 时后端拒绝新的生成请求） */
export function abortJob(jobId, abort = true) {
  return post(`/api/job/${jobId}/abort`, { abort });
}

/** 获取画风目录 + 基于音乐/歌词的推荐 */
export async function fetchStyles(jobId) {
  const r = await fetch(BASE + `/api/job/${jobId}/styles`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '获取画风失败');
  return data;
}

/** 把选中画风注入已有分镜提示词（即时生效，不重跑 LLM） */
export function applyStyle(jobId, styleIds) {
  return post('/api/storyboard/apply-style', { jobId, styleIds });
}

/** 用选中画风重新生成分镜（重跑 LLM） */
export function regenerateStyle(jobId, styleIds) {
  return post('/api/storyboard/regenerate', { jobId, styleIds });
}

export function compose(jobId) {
  return post('/api/compose', { jobId });
}

export function getJob(jobId) {
  return post(`/api/job/${jobId}`); // note: GET via fetch needs separate; see below
}

export async function fetchJob(jobId) {
  const r = await fetch(BASE + `/api/job/${jobId}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '获取任务失败');
  return data;
}

export async function fetchLogs(jobId, since = 0) {
  const r = await fetch(BASE + `/api/job/${jobId}/logs?since=${since}`);
  const data = await r.json().catch(() => ({ logs: [], nextSince: since }));
  return data;
}

/** 拉取当前处理进度（百分比 + 阶段 + 详情 + 卡死判断 stalledMs） */
export async function fetchProgress(jobId) {
  if (!jobId) return null;
  const r = await fetch(BASE + `/api/job/${jobId}/progress`);
  const data = await r.json().catch(() => null);
  return data;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
