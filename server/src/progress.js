/**
 * 任务进度中心：按 jobId 记录当前正在处理阶段的百分比、标签、详情与心跳时间。
 * 前端轮询 GET /api/job/:id/progress 获取，用于：
 *  1) 所有进度条以百分比展示；
 *  2) 通过 stalledMs（距上次更新的毫秒数）判断任务是否卡死。
 *
 * phase：storyboard | image | video | compose
 * 单个任务任一时刻只有一个活动阶段。
 */
const progressMap = new Map();

/** 开始一个阶段（重置百分比与计时） */
export function beginProgress(jobId, phase, label = '') {
  if (!jobId) return null;
  const now = Date.now();
  const p = {
    phase,
    percent: 0,
    label,
    detail: '',
    active: true,
    ok: null,
    startedAt: now,
    updatedAt: now,
  };
  progressMap.set(jobId, p);
  return p;
}

/** 更新当前阶段的百分比/标签/详情，并刷新心跳时间 */
export function setProgress(jobId, patch = {}) {
  if (!jobId) return null;
  const cur = progressMap.get(jobId) || {
    phase: patch.phase || '', percent: 0, label: '', detail: '',
    active: true, ok: null, startedAt: Date.now(),
  };
  if (patch.phase && patch.phase !== cur.phase) {
    cur.startedAt = Date.now();
    cur.percent = 0;
  }
  const next = { ...cur, ...patch, active: true, updatedAt: Date.now() };
  if (typeof next.percent === 'number') next.percent = Math.max(0, Math.min(100, Math.round(next.percent)));
  progressMap.set(jobId, next);
  return next;
}

/** 结束当前阶段（成功=100%，失败保留当前百分比），停止卡死计时 */
export function endProgress(jobId, ok = true, label = '') {
  if (!jobId) return null;
  const cur = progressMap.get(jobId);
  if (!cur) return null;
  const next = {
    ...cur,
    active: false,
    ok,
    percent: ok ? 100 : cur.percent,
    label: label || cur.label,
    updatedAt: Date.now(),
  };
  progressMap.set(jobId, next);
  return next;
}

/** 仅刷新心跳（任何日志/网络活动都视为“还活着”） */
export function touch(jobId) {
  if (!jobId) return;
  const cur = progressMap.get(jobId);
  if (cur && cur.active) {
    cur.updatedAt = Date.now();
    progressMap.set(jobId, cur);
  }
}

/** 读取进度快照，附带 stalledMs / elapsedMs */
export function getProgress(jobId) {
  const p = progressMap.get(jobId);
  if (!p) {
    return { active: false, phase: '', percent: 0, label: '', detail: '', stalledMs: 0, elapsedMs: 0, ok: null };
  }
  const now = Date.now();
  return {
    ...p,
    stalledMs: p.active ? now - p.updatedAt : 0,
    elapsedMs: now - (p.startedAt || now),
  };
}

export default { beginProgress, setProgress, endProgress, touch, getProgress };
