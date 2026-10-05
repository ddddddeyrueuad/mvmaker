import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import axios from 'axios';
import { config } from '../config.js';
import { log, timeStep } from '../logger.js';
import { touch } from '../progress.js';

// 发行包零 Python 模式下，MERT 扩展服务（MVMaker-MERT-Ext）默认监听的本地端口。
// 仅用于「未显式配置 MERT_REMOTE_URL」时的按需探测，不覆盖用户已配置的远程地址。
const MERT_PROBE_PORT = 8791;

const GENRES = ['Cinematic Orchestral', 'Ambient', 'Acoustic Pop', 'Lo-fi Hip-Hop', 'Synthwave', 'Future Bass'];
const MOODS = ['dreamy', 'energetic', 'melancholic', 'uplifting', 'warm', 'mysterious'];
const MOOD_ZH = { dreamy: '梦幻', energetic: '亢奋', melancholic: '忧郁', uplifting: '昂扬', mysterious: '神秘', warm: '温暖' };
// 【已停用】以下 mockAnalysis 及其依赖常量（MOCK_SUBJECTS/MOCK_STYLES 等）不再被调用。
// 坚决杜绝 mock 降级：analyzeAudio 在 MERT 不可用时直接抛错，绝不静默降级。
// 函数定义保留仅供将来参考，不影响运行时行为。
const MOCK_SUBJECTS = {
  male: [
    'a handsome Chinese man, dark hair, sharp jawline, warm amber key light, mysterious atmosphere, contemplative bearing',
    'a handsome Chinese man, dark hair, soft cold light, contemplative, cinematic solitude',
    'a handsome Chinese man with defined features, warm golden light, dark hair, relaxed bearing',
    'a handsome Chinese man wearing a dark coat, deep shadows, cinematic noir',
    'a handsome Chinese man in dramatic lighting, sharp features, cinematic, dynamic stance',
  ],
  female: [
    'a beautiful Chinese woman with long flowing black hair, warm lamplight, elegant bearing',
    'a beautiful Chinese woman, long dark hair, soft cool light, cinematic solitude',
    'a beautiful Chinese woman in warm radiant sunlight, long black hair, elegant posture, graceful stance',
    'a beautiful Chinese woman, warm amber lamplight, long black hair, red lips, cinematic noir',
    'a beautiful Chinese woman in dramatic blue light, long black hair flying, powerful presence, dynamic composition',
  ],
};
const MOCK_STYLES = [
  'cinematic 3d render, anamorphic lens, soft volumetric light, film grain, filmic color grading',
  'cinematic soft focus, gentle volumetric light, warm atmospheric glow, shallow depth of field, filmic color grading',
  'cinematic key visual, rich saturated colors, crisp linework, anamorphic lens flare, film grain',
];

function mockAnalysis(segments) {
  const n = segments.length;
  // 音频特征估算（与 mert_infer.py 计算逻辑对齐，使 mock 兜底也可被 mapping.js 转换为合理的视觉指令）
  const brightness = 0.30 + ((n * 11) % 45) / 100;           // 0.30~0.75
  const intensity = 0.38 + ((n % 5) * 0.11);                  // 0.38~0.82
  const warmth = +(Math.max(0, Math.min(1, 1.0 - brightness * 1.05 + (intensity - 0.5) * 0.1))).toFixed(3);
  const isWarm = warmth >= 0.45;

  // 配色：由 warmth 驱动（与 mert_infer.py 完全一致）
  let palette;
  if (warmth >= 0.6) palette = 'warm orange & cream';
  else if (warmth >= 0.45) palette = 'teal & gold';
  else if (warmth >= 0.35) palette = 'deep purple & cyan';
  else palette = 'monochrome blue';

  const mood = MOODS[n % MOODS.length];
  const moodZh = MOOD_ZH[mood];
  // 主体：按分镜数交替使用男性/女性，并通过 mood+温度选择描述
  const isMale = (n % 2 === 0);
  const subject = isMale
    ? MOCK_SUBJECTS.male[n % MOCK_SUBJECTS.male.length]
    : MOCK_SUBJECTS.female[n % MOCK_SUBJECTS.female.length];
  const style = MOCK_STYLES[n % MOCK_STYLES.length];
  const genre = GENRES[n % GENRES.length];
  const tempoBpm = Math.round(75 + ((n * 11) % 60));
  const energy = +(0.35 + ((n % 5) * 0.11)).toFixed(3);
  // 响度估算：能量 ≈ 响度区间（-26~-9 LUFS）
  const loudness = +(-26 + energy * 20).toFixed(1);

  const overall = {
    genre, mood, moodZh, tempoBpm,
    energy, loudness, warmth,
    style, colorPalette: palette, suggestedSubject: subject,
    mertMean: 0.5, mertStd: 0.15,
  };

  const segAnalysis = segments.map((s, i) => {
    const segEnergy = +(0.28 + ((i * 13) % 60) / 100).toFixed(3);
    const segBrightness = +(0.38 + ((i * 7) % 50) / 100).toFixed(3);
    const segMood = MOODS[(i + n) % MOODS.length];
    const segMoodZh = MOOD_ZH[segMood];
    const segLoudness = +(-26 + segEnergy * 20).toFixed(1);
    const segTempo = Math.round(tempoBpm + ((i * 3) % 11) - 5);
    // 能量变化 —— 相邻段能量差，用于映射转场
    const prevEnergy = i > 0 ? (0.28 + (((i - 1) * 13) % 60) / 100) : segEnergy;
    const deltaDb = +(segEnergy - prevEnergy).toFixed(1);
    const trend = deltaDb >= 3 ? 'sharp_rise' : deltaDb >= 1 ? 'rise' : deltaDb <= -1 ? 'fall' : 'flat';

    return {
      index: s.index,
      startTime: s.start,
      energy: segEnergy,
      brightness: segBrightness,
      loudness: segLoudness,
      tempoBpm: segTempo,
      mood: segMood,
      moodZh: segMoodZh,
      motion: ['slow pan', 'gentle drift', 'dolly forward', 'orbit', 'zoom in'][i % 5],
      energyDelta: { dB: deltaDb, trend },
    };
  });

  return { overall, segments: segAnalysis };
}

function runPython(scriptPath, args, onProgress = null, jobId = null) {
  return new Promise((resolve, reject) => {
    const py = config.mert.python || (process.platform === 'win32' ? 'python' : 'python3');
    // shell:true → Windows 下 = cmd.exe /d /s /c "command"。
    // 此前 node→spawn(python) 直连在沙箱后台任务环境 100% 触发 0xC0000005；
    // 但同一文件从 cmd.exe 或前台 shell 运行 100% 成功。中间插入 cmd.exe 层
    // 可规避该原生崩溃（DLL 加载路径/进程树差异），且对生产部署零影响。
    // 注意：shell:true 时使用单字符串命令以确保含空格的路径被正确转义。
    const cmd = `"${py}" "${scriptPath}" ${args.map((a) => `"${a}"`).join(' ')}`;
    const p = spawn(cmd, [], {
      shell: true,
      env: {
        // 精简环境：只传递必须项，避免沙箱环境的大量 DLL 路径污染子进程
        MERT_MODEL_PATH: config.mert.modelPath,
        OMP_NUM_THREADS: String(config.mert.ompThreads),
        MKL_NUM_THREADS: String(config.mert.ompThreads),
        OPENBLAS_NUM_THREADS: String(config.mert.ompThreads),
        NUMEXPR_NUM_THREADS: String(config.mert.ompThreads),
        MKL_DYNAMIC: 'FALSE',
        OMP_PROC_BIND: 'TRUE',
        KMP_DUPLICATE_LIB_OK: 'TRUE',
        KMP_AFFINITY: 'disabled',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        // 保活 Python 基础运行环境（Windows 下 cmd.exe + Python 需要）
        PATH: process.env.PATH || '',
        SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows',
        TEMP: process.env.TEMP || process.env.TMP || '',
        TMP: process.env.TMP || process.env.TEMP || '',
        USERPROFILE: process.env.USERPROFILE || process.env.HOME || '',
        // Python 虚拟环境专用变量
        VIRTUAL_ENV: process.env.VIRTUAL_ENV || '',
      },
    });
    let out = '', err = '', errTail = '';
    // 心跳保活 + 真·卡死看门狗：
    //  - keepAlive 间隔刷新进度时间戳：单次 mert_embed 前向（CPU 推理可能 >45s）期间
    //    不再有新 PROGRESS 行，靠它维持心跳，避免被前端误判为「卡死」。
    //  - 若子进程存活但超过 hardStallMs 仍无任何百分比进度，判定为真正卡死，
    //    杀掉进程并 reject，由 analyzeAudio 捕获后抛错（不降级 mock）。
    let lastPercentAt = Date.now();
    let settled = false;
    const keepAlive = setInterval(() => {
      if (settled) return;
      touch(jobId); // 维持心跳，避免误报「卡死」
      if (Date.now() - lastPercentAt > config.mert.hardStallMs) {
        settled = true;
        clearInterval(keepAlive);
        // shell:true 下 p.kill() 只杀 cmd.exe 壳，不杀 Python 子进程。
        // 用 taskkill 按 PID 树杀掉整棵进程树。
        try { spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { shell: true }); } catch { /* 忽略 */ }
        reject(new Error(`mert 推理超过 ${Math.round(config.mert.hardStallMs / 1000)}s 无任何进度，疑似卡死，已终止`));
      }
    }, config.mert.keepAliveMs);
    p.stdout.on('data', (d) => (out += d));
    // stderr 中形如 "PROGRESS {json}" 的行是进度打点，其余作为错误信息累积
    p.stderr.on('data', (d) => {
      errTail += d.toString();
      const lines = errTail.split(/\r?\n/);
      errTail = lines.pop(); // 保留可能不完整的最后一行
      for (const line of lines) {
        const m = line.match(/^PROGRESS\s+(\{.*\})\s*$/);
        if (m && onProgress) {
          try {
            onProgress(JSON.parse(m[1]));
            lastPercentAt = Date.now(); // 真实进度到达，重置看门狗
          } catch { /* 忽略解析失败 */ }
        } else if (line.trim()) {
          err += line + '\n';
        }
      }
    });
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      reject(new Error(`mert 无法启动 python：${e.message}`));
    });
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      if (errTail.trim() && !/^PROGRESS\s+/.test(errTail)) err += errTail;
      if (code !== 0) return reject(new Error(`mert 推理退出码 ${code}: ${err.slice(-500)}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch (e) { reject(new Error('mert 输出解析失败: ' + out.slice(0, 300))); }
    });
  });
}

async function localAnalyze(audioPath, segments, onProgress, jobId) {
  const scriptPath = path.join(config.paths.root, 'mert_infer.py');
  const args = [audioPath, String(config.output.segmentSeconds), String(segments.length)];
  return runPython(scriptPath, args, onProgress, jobId);
}

/**
 * 远程 MERT 分析（本地零 Python 模式）。
 * 把音频文件以 multipart 上传到远程分析服务，远程返回与本地 mert_infer.py 完全一致的
 * { overall, segments } schema。远程服务应实现同样的 warmth/loudness/mood 计算逻辑。
 */
async function remoteAnalyze(audioPath, segments, jobId, remoteUrl) {
  const url = remoteUrl || config.mert.remoteUrl;
  const buf = fs.readFileSync(audioPath);
  const fd = new FormData();
  // Node 18+ 原生 FormData/Blob，无需额外依赖
  fd.append('audio', new Blob([buf]), path.basename(audioPath));
  fd.append('segmentSeconds', String(config.output.segmentSeconds));
  fd.append('segments', JSON.stringify(segments));
  const headers = {};
  if (config.mert.remoteToken) headers.Authorization = `Bearer ${config.mert.remoteToken}`;
  // 心跳保活：远程 MERT 模型加载/推理可能持续数分钟（首次冷启动 4~5 分钟），
  // axios.post 阻塞期间后端无法发进度，前端会误判「卡死」。每 keepAliveMs 刷新一次进度时间戳，
  // 与 runPython 的本地 MERT 心跳保持同一机制（keepAliveMs 默认 8s，远小于前端卡死阈值）。
  let settled = false;
  const keepAlive = setInterval(() => {
    if (settled) return;
    touch(jobId);
  }, config.mert.keepAliveMs);
  try {
    const { data } = await axios.post(url, fd, {
      headers,
      timeout: config.mert.remoteTimeoutMs,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    if (!data || !data.overall || !Array.isArray(data.segments)) {
      throw new Error('远程 MERT 返回格式非法（缺 overall/segments）');
    }
    return data;
  } finally {
    settled = true;
    clearInterval(keepAlive);
  }
}

/**
 * 解析远程 MERT 分析地址（Option B：server 端按需探测，不触碰 Electron）。
 * 优先级：
 *   1) 用户/包内 config.env 已显式配置 MERT_REMOTE_URL → 原样返回（绝不覆盖）。
 *   2) 本地 MERT 推理可用（MERT_LOCAL=1 且模型存在）→ 返回 ''，交由本地分支处理
 *      （保持 dev / 本机行为完全不变）。
 *   3) 以上皆无 → 探测本地默认端口（MERT_PROBE_PORT）的 MERT 服务：GET /health
 *      返回 ok:true 即自动启用远程分析；失败/超时（800ms）则返回空串，
 *      由 analyzeAudio 抛错（坚决杜绝 mock 降级，要求用户启动 MERT 服务）。
 * @param {boolean} canUseLocal 是否已具备本地 MERT 推理条件
 */
async function resolveRemoteUrl(jobId, canUseLocal) {
  // 用户已显式配置远程地址 → 直接返回（不覆盖用户自定义远程地址）
  if (config.mert.remoteUrl) return config.mert.remoteUrl;
  // 本地推理可用 → 优先本地，不做远程探测（保持 dev / 本机行为不变）
  if (canUseLocal) return '';
  // 按需探测本地默认端口的 MERT 服务（发行包零 Python 模式）
  try {
    const base = `http://127.0.0.1:${MERT_PROBE_PORT}`;
    const { data } = await axios.get(`${base}/health`, {
      timeout: 800,
      validateStatus: () => true,
    });
    if (data && data.ok === true) {
      log(jobId, 'info', 'storyboard', `自动探测到本地 MERT 服务（${base}），启用远程分析`);
      return `${base}/mert`;
    }
  } catch {
    /* 端口未监听或探测异常：返回空串，由 analyzeAudio 抛错（不降级 mock） */
  }
  return '';
}

/**
 * 分析音频。
 * @param {function} onSub 子进度回调：({ percent, label, done, total }) percent 为 MERT 内部 0-100。
 */
export async function analyzeAudio(audioPath, segments, jobId = null, onSub = null) {
  const done = timeStep(jobId, 'storyboard', `mert 音频分析（${segments.length} 段）`);

  const canUseLocal =
    config.mert.local && config.mert.modelPath && fs.existsSync(config.mert.modelPath);

  // 解析远程 MERT 地址：用户显式配置优先；否则（发行包且未启用本地推理时）按需探测本地默认端口。
  const remoteUrl = await resolveRemoteUrl(jobId, canUseLocal);

  if (remoteUrl) {
    log(jobId, 'info', 'storyboard', `调用远程 MERT 分析服务（${remoteUrl}）…`);
    log(jobId, 'info', 'storyboard', `远程 MERT 完整分析约需 4~5 分钟（首次含模型加载更慢），期间进度条会停留在本阶段，属正常，请耐心等待、勿关闭程序。`);
    if (onSub) onSub({ percent: 10, label: '远程 MERT 分析中（约 4~5 分钟，请耐心等待）…' });
    // 远程 MERT 重试：首次冷启动可能超时（模型加载 4~5 分钟），重试时模型已加载会快很多。
    // MERT 服务改为单线程 HTTPServer，重试请求会排队等首个完成后再处理，无并发竞态。
    const maxRemoteTries = 2;
    let lastRemoteErr = null;
    for (let attempt = 1; attempt <= maxRemoteTries; attempt++) {
      try {
        if (attempt > 1) {
          log(jobId, 'warn', 'storyboard', `远程 MERT 首次请求超时（冷启动模型加载中），自动重试第 ${attempt} 次…`);
          if (onSub) onSub({ percent: 15, label: '远程 MERT 重试中（模型已加载，预计较快）…' });
        }
        const res = await remoteAnalyze(audioPath, segments, jobId, remoteUrl);
        if (onSub) onSub({ percent: 100, label: '远程 MERT 分析完成' });
        done(true, `远程分析 流派=${res?.overall?.genre || '?'}`);
        return res;
      } catch (e) {
        lastRemoteErr = e;
        const isTimeout = e.code === 'ECONNABORTED' || /timeout/i.test(e.message);
        if (attempt < maxRemoteTries && isTimeout) {
          log(jobId, 'warn', 'storyboard', `远程 MERT 第 ${attempt} 次请求超时：${e.message}（MERT 服务可能仍在加载模型，将自动重试）`);
          await new Promise((r) => setTimeout(r, 5000));
        } else {
          throw e;
        }
      }
    }
    throw new Error(`远程 MERT 分析失败（已重试 ${maxRemoteTries} 次）：${lastRemoteErr?.message || '未知错误'}`);
  }

  if (canUseLocal) {
    const maxTries = Math.max(1, config.mert.retries + 1); // retries 为额外重试次数
    let lastErr = null;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        if (attempt > 1) log(jobId, 'warn', 'storyboard', `本地 MERT 第 ${attempt} 次尝试（上次失败：${lastErr?.message || ''}）`);
        else log(jobId, 'info', 'storyboard', `调用本地 MERT 模型推理（${segments.length} 段，CPU 推理，逐段进度见下）…`);
        let lastLoggedDone = 0;
        const res = await localAnalyze(audioPath, segments, (p) => {
          if (onSub) onSub(p);
          // 逐段完成时打一条日志（首段/每段都打，避免长时间静默）
          if (typeof p.done === 'number' && p.done !== lastLoggedDone) {
            lastLoggedDone = p.done;
            log(jobId, 'info', 'storyboard', `MERT 分析进度 ${p.done}/${p.total} 段（${Math.round(p.percent)}%）`);
          } else if (typeof p.done !== 'number' && p.label) {
            log(jobId, 'info', 'storyboard', `MERT：${p.label}（${Math.round(p.percent)}%）`);
          }
        }, jobId);
        if (attempt > 1) log(jobId, 'info', 'storyboard', `本地 MERT 第 ${attempt} 次尝试成功`);
        done(true, `流派=${res?.overall?.genre || '?'}`);
        return res;
      } catch (e) {
        lastErr = e;
        // 偶发 0xC0000005 原生崩溃：一次全新 spawn 大概率成功，重试前稍作冷却避免连崩。
        if (attempt < maxTries) {
          log(jobId, 'error', 'storyboard', `本地 MERT 推理失败（将自动重试 ${config.mert.retries} 次）：${e.message}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    throw new Error(`本地 MERT 推理失败（已重试 ${config.mert.retries} 次）：${lastErr?.message || '未知错误'}。请检查 MERT 模型路径与 Python 环境。`);
  }

  throw new Error('MERT 未启用：未配置 MERT_REMOTE_URL，且 MERT_LOCAL≠1，本地端口 8791 也未探测到 MERT 服务。请启动 MVMaker-MERT-Ext 服务（start_mert.bat）或配置 MERT_REMOTE_URL 后重试。');
}
