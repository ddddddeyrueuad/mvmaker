import fs from 'node:fs';
import path from 'node:path';
import { config, mediaSizes } from '../config.js';
import { runFF } from '../utils/ffmpeg.js';
import { log } from '../logger.js';
import { setProgress } from '../progress.js';

/**
 * 合成最终 MV：
 * 1) 每段视频归一化为固定时长(SEGMENT_SECONDS)、统一分辨率、同编码
 * 2) concat 拼接
 * 3) 与原始无损音频(48k) mux，-shortest 保证音视频时间完全对齐
 */
export async function composeMV(jobDir, videoPaths, audioPath, outPath, jobId = null, orientation = 'landscape') {
  const vz = mediaSizes(orientation).video;
  const W = vz.width, H = vz.height;
  const { segmentSeconds, audioSampleRate } = config.output;
  const tmp = path.join(jobDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const t0 = Date.now();
  setProgress(jobId, { phase: 'compose', percent: 0, label: '开始合成 MV（归一化各段视频）…', detail: `${videoPaths.length} 段，目标 ${W}x${H}` });
  log(jobId, 'info', 'compose', `开始合成 MV（${mediaSizes(orientation).orientation === 'portrait' ? '竖屏' : '横屏'} ${W}x${H}）：归一化 ${videoPaths.length} 段视频 → 拼接 → 对齐音频`);

  const normPaths = [];
  for (let i = 0; i < videoPaths.length; i++) {
    const norm = path.join(tmp, `norm_${String(i + 1).padStart(3, '0')}.mp4`);
    log(jobId, 'info', 'compose', `归一化第 ${i + 1}/${videoPaths.length} 段（${W}x${H}, ${segmentSeconds}s）…`);
    setProgress(jobId, { percent: Math.round(((i + 1) / videoPaths.length) * 80), label: `归一化第 ${i + 1}/${videoPaths.length} 段视频…`, detail: `${W}x${H}, ${segmentSeconds}s` });
    await runFF([
      '-y', '-i', videoPaths[i],
      '-t', String(segmentSeconds),
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_duration=${segmentSeconds}`,
      '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-an',
      norm,
    ]);
    normPaths.push(norm);
  }

  // 拼接清单
  const listFile = path.join(tmp, 'concat.txt');
  fs.writeFileSync(listFile, normPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  const concatPath = path.join(tmp, 'concat.mp4');
  setProgress(jobId, { percent: 85, label: '各段视频拼接中…' });
  log(jobId, 'info', 'compose', '拼接各段视频…');
  await runFF([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', concatPath,
  ]);

  // 音视频合成：视频 copy，音频重采样为 48k 无损(pcm)，-shortest 对齐
  setProgress(jobId, { percent: 92, label: '对齐原始无损音频并封装…' });
  log(jobId, 'info', 'compose', `与原始音频 mux（${audioSampleRate}Hz 无损 pcm，-shortest 对齐）…`);
  await runFF([
    '-y', '-i', concatPath, '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'pcm_s16le', '-ar', String(audioSampleRate),
    '-shortest', '-movflags', '+faststart',
    outPath,
  ]);

  const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  setProgress(jobId, { percent: 100, label: 'MV 合成完成 ✓' });
  log(jobId, 'info', 'compose', `✓ MV 合成完成（${Date.now() - t0}ms, ${sz} bytes）：${outPath}`);
  return outPath;
}
