/**
 * 内存任务存储（带磁盘持久化）。
 * - 每次 createJob / updateJob 都会把任务写入 server/uploads/<jobId>/job.json，
 *   因此后端重启（含 .bat 手动重启）后任务不会丢失，前端「恢复任务」即可继续。
 * - 启动时调用 loadJobsOnStartup() 扫描 uploads 目录恢复所有历史任务。
 *
 * job 结构：
 * {
 *   id, createdAt,
 *   audio: { originalName, path, duration, ext },
 *   segments: [{ index, start, duration, path }],
 *   lyrics: string|null,
 *   analysis: object|null,                 // mert 分析结果
 *   storyboard: {                          // LLM 生成的分镜
 *      character, style, globalPrompt, globalVideoPrompt,
 *      segments: [{ index, imagePrompt, videoPrompt, caption }]
 *   } | null,
 *   images: [{ index, prompt, url, path }],
 *   videos: [{ index, prompt, url, path }],
 *   finalMv: { url, path } | null,
 *   status: string
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const jobs = new Map();
const uploadsRoot = config.paths.uploads;

function jobJsonPath(jobId) {
  return path.join(uploadsRoot, jobId, 'job.json');
}

/** 把任务写入磁盘（容错：写入失败不影响主流程） */
function persist(job) {
  try {
    if (!job || !job.id) return;
    const file = jobJsonPath(job.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(job, null, 2));
  } catch (e) {
    // 持久化失败不应阻断主流程，仅打印警告
    console.warn(`[store] 持久化任务 ${job?.id || '?'} 失败：${e.message}`);
  }
}

export function createJob(id, data) {
  const job = { id, createdAt: Date.now(), status: 'created', ...data };
  jobs.set(id, job);
  persist(job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  persist(job);
  return job;
}

export function listJobs() {
  return [...jobs.values()];
}

/** 启动时扫描 uploads 目录，恢复所有落盘的任务（幂等、容错） */
export function loadJobsOnStartup() {
  let count = 0;
  try {
    if (!fs.existsSync(uploadsRoot)) return 0;
    for (const entry of fs.readdirSync(uploadsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(uploadsRoot, entry.name, 'job.json');
      if (!fs.existsSync(file)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (job && job.id) {
          jobs.set(job.id, job);
          count++;
        }
      } catch (e) {
        console.warn(`[store] 恢复任务 ${entry.name} 失败（job.json 损坏，已跳过）：${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[store] 扫描 uploads 目录失败：${e.message}`);
  }
  if (count) console.log(`[store] 已从磁盘恢复 ${count} 个历史任务`);
  return count;
}

export default { createJob, getJob, updateJob, listJobs, loadJobsOnStartup };
