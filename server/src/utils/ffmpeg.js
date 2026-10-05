import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

// ffmpeg / ffprobe 可执行文件路径：默认走 PATH，Electron 打包后由 config.paths 指向随包 ffmpeg。
const FFMPEG = config.paths.ffmpeg || 'ffmpeg';
const FFPROBE = config.paths.ffprobe || 'ffprobe';

/**
 * 运行一个 ffmpeg / ffprobe 命令，返回 Promise<{ stdout, stderr, code }>
 * 注意：ffmpeg 通常把信息输出到 stderr，因此用 stderr 判断进度。
 */
export function runFF(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

export function runFFprobe(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`ffprobe exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

/** 取得音频/视频时长（秒，浮点） */
export async function getDuration(file) {
  const out = await runFFprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return parseFloat(String(out).trim());
}

export const sleep = promisify(setTimeout);
