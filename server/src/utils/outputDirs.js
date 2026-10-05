/**
 * 对外归档产物管理：report / temp clip / output 三个目录。
 *
 * 命名规则（贯穿一次任务全程，保证三处命名一致）：
 *   runTag = 音频名(去扩展名, 清洗非法字符) + '_' + 时间戳(YYYYMMDD_HHMMSS)
 *   - report/<runTag>.json                 完整 MERT 分析报告 + 完整分镜脚本
 *   - temp clip/<runTag>/img_NNN.png       分镜图片片段
 *   - temp clip/<runTag>/vid_NNN.mp4       视频片段
 *   - output/<runTag>.mp4                  最终成品 MV
 *
 * 所有写入均为「尽力而为」：失败仅打印警告，绝不影响主流程（生成/合成照常完成）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** 清洗文件名中的非法/空格字符为下划线。保留中文与字母数字。 */
export function sanitizeName(name) {
  if (!name) return 'audio';
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'audio';
}

/**
 * 由音频原始文件名生成 runTag。
 * 时间戳取本地时间 YYYYMMDD_HHMMSS，保证同一任务的三处产物命名一致。
 */
export function makeRunTag(originalName = 'audio') {
  const base = sanitizeName(String(originalName).replace(/\.[^.]+$/, ''));
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${base}_${ts}`;
}

export function reportFilePath(runTag, ext = 'json') {
  return path.join(config.paths.report, `${runTag}.${ext}`);
}
export function outputFilePath(runTag, ext = 'mp4') {
  return path.join(config.paths.output, `${runTag}.${ext}`);
}
export function tempClipDir(runTag) {
  return path.join(config.paths.tempClip, runTag);
}

/** 确保三个归档目录存在（幂等）。 */
export function ensureOutputDirs() {
  for (const d of [config.paths.report, config.paths.tempClip, config.paths.output]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { console.warn(`[output] 创建目录失败 ${d}: ${e.message}`); }
  }
}

/**
 * 保存「完整 MERT 分析报告 + 完整分镜脚本」到 report/<runTag>.json。
 * 返回写入的文件路径（失败返回 null）。
 */
export function saveReport(job) {
  if (!job?.runTag) return null;
  try {
    fs.mkdirSync(config.paths.report, { recursive: true });
    const payload = {
      audioName: job.audio?.originalName || null,
      jobId: job.id,
      orientation: job.orientation,
      styleIds: job.styleIds || [],
      generatedAt: new Date().toISOString(),
      // 完整 MERT 分析（含每段 brightness/energy/loudness/mood/... 与 overall）
      analysis: job.analysis,
      // 完整分镜脚本（globalPrompt/globalVideoPrompt + 每段 imagePrompt/videoPrompt/caption/...）
      storyboard: job.storyboard,
    };
    const file = reportFilePath(job.runTag);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  } catch (e) {
    console.warn(`[output] 保存分析报告失败：${e.message}`);
    return null;
  }
}

/**
 * 把分镜图片/视频片段复制进 temp clip/<runTag>/（沿用相同文件名）。
 * outName 形如 img_001.png / vid_001.mp4。返回目标路径（失败返回 null）。
 */
export function copyClipArtifact(runTag, outName, srcPath) {
  if (!runTag || !srcPath) return null;
  try {
    const dir = tempClipDir(runTag);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(outName));
    fs.copyFileSync(srcPath, dest);
    return dest;
  } catch (e) {
    console.warn(`[output] 复制分镜片段失败：${e.message}`);
    return null;
  }
}

/** 把最终成品 MV 复制进 output/<runTag>.mp4。返回目标路径（失败返回 null）。 */
export function copyFinal(runTag, srcPath) {
  if (!runTag || !srcPath) return null;
  try {
    fs.mkdirSync(config.paths.output, { recursive: true });
    const dest = outputFilePath(runTag);
    fs.copyFileSync(srcPath, dest);
    return dest;
  } catch (e) {
    console.warn(`[output] 复制成品视频失败：${e.message}`);
    return null;
  }
}
