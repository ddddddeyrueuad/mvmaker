import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runFF, getDuration } from '../utils/ffmpeg.js';

/**
 * 上传音频后：取时长，按 SEGMENT_SECONDS 切片。
 * 返回 { duration, segments: [{index, start, duration, path}] }
 * 切片数量 N 即后续分镜脚本数量。
 */
export async function sliceAudio(audioPath, jobDir) {
  const duration = await getDuration(audioPath);
  const seg = config.output.segmentSeconds;
  const n = Math.max(1, Math.ceil(duration / seg));
  const segments = [];
  for (let i = 0; i < n; i++) {
    const start = i * seg;
    const len = Math.min(seg, duration - start);
    const outName = `seg_${String(i + 1).padStart(3, '0')}.wav`;
    const outPath = path.join(jobDir, outName);
    await runFF([
      '-y', '-ss', String(start), '-t', String(len),
      '-i', audioPath,
      '-c:a', 'pcm_s16le', outPath,
    ]);
    segments.push({ index: i, start, duration: len, path: outPath });
  }
  return { duration, segments };
}

export function ensureJobDir(jobDir) {
  fs.mkdirSync(jobDir, { recursive: true });
  return jobDir;
}
