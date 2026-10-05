import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env 路径：默认 server/.env；Electron 打包后由 ENV_FILE 指向可写的 userData 目录，
// 使「测试并保存 Key」在安装到 Program Files（只读）后仍能持久化。
const ENV_PATH = process.env.ENV_FILE
  ? path.resolve(process.env.ENV_FILE)
  : path.resolve(__dirname, '../.env');
dotenv.config({ path: ENV_PATH });

const num = (v, d) => (v == null || v === '' ? d : Number(v));

const agnesDefaults = {
  baseUrl: (process.env.AGNES_BASE_URL || '').replace(/\/+$/, ''),
  authType: process.env.AGNES_AUTH_TYPE || 'bearer',
  apiKey: process.env.AGNES_API_KEY || '',
  chatPath: process.env.AGNES_CHAT_PATH || '/v1/chat/completions',
  t2iPath: process.env.AGNES_T2I_PATH || '/v1/images/generations',
  i2vPath: process.env.AGNES_I2V_PATH || '/v1/videos',
  // 视频异步轮询：GET <base去掉/v1>/agnesapi?video_id=<ID>
  videoPollPath: process.env.AGNES_VIDEO_POLL_PATH || '/agnesapi',
  videoPollParam: process.env.AGNES_VIDEO_POLL_PARAM || 'video_id',
  chatModel: process.env.AGNES_CHAT_MODEL || 'agnes-2.5-flash',
  t2iModel: process.env.AGNES_T2I_MODEL || 'agnes-image-2.1-flash',
  i2vModel: process.env.AGNES_I2V_MODEL || 'agnes-video-v2.0',
  t2iSize: process.env.AGNES_T2I_SIZE || '1024x768',
  videoFrameRate: num(process.env.AGNES_VIDEO_FPS, 24),
  videoNumFrames: num(process.env.AGNES_VIDEO_FRAMES, 241),
  cooldownSec: num(process.env.AGNES_COOLDOWN_SEC, 10),
  // 负面提示词（尽量详细）。
  // 图片：agnes-image-2.1-flash 官方 API 不支持独立 negative_prompt 字段，
  //   因此把这些约束以 "Avoid: ..." 文本形式追加进正面提示词（prompt）中。
  // 视频：agnes-video-v2.0 官方 API 原生支持 negative_prompt 字段，直接发送。
  imageNegativePrompt: process.env.AGNES_IMAGE_NEGATIVE_PROMPT || 'Avoid: ugly, blurry, lowres, bad anatomy, extra limbs, text, signature, watermark, deformed, disfigured, mutated hands, fused fingers, too many fingers, cropping, out of frame, bad proportions, poorly drawn face',
  videoNegativePrompt: process.env.AGNES_VIDEO_NEGATIVE_PROMPT || 'ugly, blurry, lowres, bad anatomy, extra limbs, text, signature, watermark, deformed, disfigured, mutated hands, fused fingers, too many fingers, cropping, out of frame, bad proportions, poorly drawn face, static, frozen, jittery, flickering artifacts, color banding',
};

export const config = {
  port: num(process.env.PORT, 3001),

  agnes: agnesDefaults,

  mert: {
    modelPath: process.env.MERT_MODEL_PATH || 'D:/TEST/music-mert/models/MERT-v1-95M',
    python: process.env.MERT_PYTHON || '',
    // 是否启用本地 MERT 推理（需先装好 torch/transformers/librosa）。
    // 0=关闭；1=启用(调用 server/mert_infer.py)
    // 发行包（Electron）默认关闭 → 本地零 Python，音乐分析走远程或自动探测本地 8791 服务。
    local: process.env.MERT_LOCAL === '1',
    // 远程 MERT 分析服务（本地零 Python 时使用）。配置后音乐分析走远程 HTTP，
    // multipart 上传音频 + segments/segmentSeconds；返回与本地 mert_infer.py 同 schema。
    // 留空则不启用远程；本地也未启用时自动探测 8791 端口 MERT 服务，探测失败将抛错（不降级 mock）。
    remoteUrl: (process.env.MERT_REMOTE_URL || '').replace(/\/+$/, ''),
    remoteToken: process.env.MERT_REMOTE_TOKEN || '',
    // 远程 MERT 单次分析耗时很长（包二 MVMaker-MERT-Ext 实测：模型加载 + MERT 整曲深度分析
    // 约 248s + 逐段声学特征提取，首跑约 4~5 分钟，后续约 4 分钟）。
    // 旧版 .env.dist 曾默认 120000ms(2分钟)，升级后 config.env 残留该值会导致首次必超时。
    // 此处强制最小 480000ms(8分钟)，即使用户 config.env 里设了更小值也自动提升；
    // 默认 600000ms(10分钟) 留足冷启动余量；仍可用 MERT_REMOTE_TIMEOUT_MS 设更大值。
    remoteTimeoutMs: Math.max(num(process.env.MERT_REMOTE_TIMEOUT_MS, 600000), 480000),
    // 限制 Python 子进程内 BLAS/OpenMP 线程数。
    // 默认 1：Intel MKL 在 Windows 上多线程初始化存在 0xC0000005（访问越界）竞态，
    // 单线程可彻底消除该崩溃类别；代价是 CPU 前向约慢 30%。需要更高吞吐可设 MERT_OMP_THREADS。
    ompThreads: num(process.env.MERT_OMP_THREADS, 1),
    // 本地 MERT 子进程偶发 0xC0000005 原生崩溃（非确定性，多在 Python/torch 导入阶段）。
    // 一次全新 spawn 大概率成功，故失败自动重试，避免直接报错丢掉真实分析。
    retries: num(process.env.MERT_RETRIES, 2),
    // 子进程存活期间刷新进度心跳的间隔（ms）：单次 mert_embed 前向可能 >45s，
    // 此心跳可避免被误判为「卡死」。
    keepAliveMs: num(process.env.MERT_KEEPALIVE_MS, 8000),
    // 真·卡死看门狗：子进程存活但超过此时长（ms）仍无任何百分比进度，则杀掉并抛错（不降级 mock）。
    hardStallMs: num(process.env.MERT_HARD_STALL_MS, 600000),
  },

  output: {
    width: num(process.env.OUTPUT_WIDTH, 1280),
    height: num(process.env.OUTPUT_HEIGHT, 720),
    segmentSeconds: num(process.env.SEGMENT_SECONDS, 10),
    audioSampleRate: num(process.env.AUDIO_SAMPLE_RATE, 48000),
    // 默认画面方向（可在页面切换）。portrait=竖屏 3:4，landscape=横屏 4:3
    orientation: (process.env.OUTPUT_ORIENTATION || 'landscape').toLowerCase() === 'portrait' ? 'portrait' : 'landscape',
  },

  paths: {
    root: path.resolve(__dirname, '..'),
    // 产物目录：默认 server/uploads；Electron 打包后由 UPLOADS_DIR 指向 userData（asar 内不可写）。
    uploads: process.env.UPLOADS_DIR
      ? path.resolve(process.env.UPLOADS_DIR)
      : path.resolve(__dirname, '../uploads'),
    // 前端构建产物目录：默认 ../client/dist；Electron 打包后由 CLIENT_DIST 覆盖。
    clientDist: process.env.CLIENT_DIST
      ? path.resolve(process.env.CLIENT_DIST)
      : path.resolve(__dirname, '../../client/dist'),
    // ffmpeg / ffprobe 可执行文件路径：默认走 PATH；Electron 打包后由 env 指向随包 ffmpeg。
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
    // 产物对外归档目录（可用 env 覆盖到可写位置，如 Electron 的 userData）：
    //   report    —— 完整 MERT 分析报告 + 完整分镜脚本（<音频名>_<时间戳>.json）
    //   tempClip  —— 分镜图片与视频片段（<音频名>_<时间戳>/img_NNN.png、vid_NNN.mp4）
    //   output    —— 最终成品 MV（<音频名>_<时间戳>.mp4）
    // 默认落在项目根（config.paths.root 的上一级），即与 server/ 同级。
    report: process.env.REPORT_DIR
      ? path.resolve(process.env.REPORT_DIR)
      : path.resolve(__dirname, '../../report'),
    tempClip: process.env.TEMP_CLIP_DIR
      ? path.resolve(process.env.TEMP_CLIP_DIR)
      : path.resolve(__dirname, '../../temp clip'),
    output: process.env.OUTPUT_DIR
      ? path.resolve(process.env.OUTPUT_DIR)
      : path.resolve(__dirname, '../../output'),
  },
};

/**
 * 合并 .env 默认值与「用户在页面输入的」覆盖（job.agnes = {apiKey, baseUrl}）。
 * 返回带 enabled 标志的有效 agnes 配置。
 */
export function resolveAgnes(overrides) {
  const base = { ...config.agnes };
  if (overrides && typeof overrides === 'object') {
    if (overrides.apiKey) base.apiKey = overrides.apiKey;
    if (overrides.baseUrl) base.baseUrl = String(overrides.baseUrl).replace(/\/+$/, '');
  }
  // 所有 path（chatPath/t2iPath/i2vPath）均已包含 /v1，因此 baseUrl 末尾不能再带 /v1，
  // 否则会拼接出 https://.../v1/v1/... 导致 404。统一在这里去掉末尾的 /v1。
  base.baseUrl = base.baseUrl.replace(/\/v1$/, '');
  base.enabled = Boolean(base.baseUrl && base.apiKey);
  return base;
}

/**
 * 持久化保存 Agnes 配置：同时更新「运行内存」(config.agnes) 与 .env 文件（userData/config.env）。
 * 用途：用户在页面「测试并保存」通过后，把有效 Key/BaseUrl 落盘，
 * 此后无论怎么重启后端都自带该 Key，页面无需再次输入。
 * 只写传入的字段（apiKey / baseUrl），不动 .env 里其它配置。
 * 注意：落盘位置为 userData（AppData），与安装目录分离，不会随安装包分发。
 */
export function saveAgnesConfig({ apiKey, baseUrl } = {}) {
  if (apiKey) config.agnes.apiKey = apiKey;
  if (baseUrl) config.agnes.baseUrl = String(baseUrl).replace(/\/+$/, '');

  let env = '';
  try { env = fs.readFileSync(ENV_PATH, 'utf8'); } catch { env = ''; }
  const upsert = (text, key, val) => {
    const line = `${key}=${val}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) return text.replace(re, line);
    return text.replace(/\s*$/, '') + `\n${line}\n`;
  };
  if (apiKey) env = upsert(env, 'AGNES_API_KEY', apiKey);
  if (baseUrl) env = upsert(env, 'AGNES_BASE_URL', String(baseUrl).replace(/\/+$/, ''));
  fs.writeFileSync(ENV_PATH, env);
  return { apiKey: config.agnes.apiKey, baseUrl: config.agnes.baseUrl };
}

/** 返回给前端展示的「已保存 Key」信息（脱敏，绝不返回明文）。 */
export function agnesConfigSummary() {
  const key = config.agnes.apiKey || '';
  const masked = key ? `${key.slice(0, 6)}••••${key.slice(-4)}` : '';
  return { hasKey: Boolean(key), keyMasked: masked, baseUrl: config.agnes.baseUrl || '' };
}

/**
 * 根据画面方向返回图片/视频分辨率。
 * 图片：竖屏 1024×1792（3:4）/ 横屏 1792×1024（4:3）
 * 视频：竖屏 720×960（3:4）/ 横屏 960×720（4:3）
 * 帧数 241、24fps、≈10s（由 agnes.videoNumFrames / videoFrameRate 控制，必须符合 8n+1）
 */
export function mediaSizes(orientation) {
  const o = orientation === 'portrait' ? 'portrait' : 'landscape';
  return {
    orientation: o,
    image: o === 'portrait' ? { width: 1024, height: 1792 } : { width: 1792, height: 1024 },
    video: o === 'portrait' ? { width: 720, height: 960 } : { width: 960, height: 720 },
  };
}
