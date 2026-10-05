/**
 * 结构化日志：按 jobId 存储处理日志，前端可轮询查看。
 * 级别：info / warn / error。error 会高亮显示。
 */
import { touch } from './progress.js';

const CAP = 2000;
const buffers = new Map();

function jobLog(jobId) {
  if (!buffers.has(jobId)) buffers.set(jobId, []);
  return buffers.get(jobId);
}

/**
 * 写入一条日志。
 * @param {string|null} jobId 任务 ID（null 表示全局/非任务日志）
 * @param {'info'|'warn'|'error'} level
 * @param {string} step 步骤标识：upload/storyboard/image/video/compose/system
 * @param {string} msg
 */
export function log(jobId, level, step, msg) {
  const entry = { ts: Date.now(), level, step, msg };
  const buf = jobLog(jobId);
  buf.push(entry);
  if (buf.length > CAP) buf.splice(0, buf.length - CAP);
  touch(jobId); // 任何日志活动都刷新进度心跳，用于卡死检测
  const tag = jobId ? `[${jobId.slice(0, 8)}]` : '[global]';
  const line = `[${level.toUpperCase()}][${step}]${tag} ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

/** 读取日志（可指定自某索引之后的增量） */
export function getLogs(jobId, since = 0) {
  const buf = buffers.get(jobId) || [];
  const slice = since > 0 ? buf.slice(since) : buf;
  return { logs: slice, nextSince: buf.length };
}

/** 启动一个步骤的计时日志，返回结束函数 */
export function timeStep(jobId, step, label) {
  const t0 = Date.now();
  log(jobId, 'info', step, `▶ 开始：${label}`);
  return (ok = true, extra = '') => {
    const ms = Date.now() - t0;
    const verb = ok ? '✓ 完成' : '✗ 失败';
    log(jobId, ok ? 'info' : 'error', step, `${verb}：${label}（${ms}ms）${extra ? ' — ' + extra : ''}`);
  };
}
