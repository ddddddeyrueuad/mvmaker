import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { mediaSizes } from '../config.js';
import { log } from '../logger.js';
import { setProgress } from '../progress.js';
import { withAgnesRetry, isContentPolicyViolation, sanitizeForContentPolicy, sanitizeForContentPolicyAggressive } from './agnesHttp.js';

function authHeaders(agnes) {
  const h = { 'Content-Type': 'application/json' };
  if (agnes.authType === 'x-api-key') h['X-API-Key'] = agnes.apiKey;
  else h['Authorization'] = `Bearer ${agnes.apiKey}`;
  return h;
}

function pollBase(agnes) {
  return agnes.baseUrl.replace(/\/v1$/, '').replace(/\/+$/, '');
}

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function toDataUri(filePath) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mimeOf(filePath)};base64,${b64}`;
}

function findVideoUrl(data) {
  return (
    data?.url ||
    data?.video_url ||
    data?.result?.url ||
    data?.data?.url ||
    data?.output?.url ||
    (Array.isArray(data?.videos) ? data.videos[0]?.url : null) ||
    null
  );
}

function isTerminal(data) {
  const st = String(data?.status || data?.state || '').toLowerCase();
  if (['failed', 'error', 'cancelled'].includes(st)) return 'failed';
  if (['succeeded', 'completed', 'done', 'success', 'ready'].includes(st)) return 'done';
  if (findVideoUrl(data)) return 'done';
  return 'pending';
}

async function realGenerate(agnes, outPath, imagePath, prompt, globalVideoPrompt, jobId = null, orientation = 'landscape', negativePrompt = '', index = 0) {
  const dataUri = toDataUri(imagePath);
  const vz = mediaSizes(orientation).video;
  // 表情约束负面词：用委婉正面表达替代直白触发词（crying/tears 等），
  // 避免内容审查过滤器关键词匹配误伤；同时防止图生视频把首帧表情扭曲成怪异表情。
  const EXPR_NEG = 'serene composed expression, calm gentle demeanor, no extreme emotions, no exaggerated expressions, no distorted faces, no emotional outbursts';
  const fullNeg = negativePrompt ? `${negativePrompt}, ${EXPR_NEG}` : EXPR_NEG;
  const body = {
    model: agnes.i2vModel,
    prompt: `${globalVideoPrompt}\n${prompt}`.trim(),
    negative_prompt: fullNeg, // agnes-video-v2.0 原生支持负面提示词
    height: vz.height,
    width: vz.width,
    num_frames: agnes.videoNumFrames,
    frame_rate: agnes.videoFrameRate,
    tags: ['i2v'],
    image: [dataUri], // 图生视频输入图（data URI；若服务端仅接受公网 URL，请改为托管后传入）
    extra_body: { image: [dataUri] },
  };

  // 提交函数封装：用于 content_policy_violation 时净化后重试
  const submitRequest = async (reqBody) => {
    return await withAgnesRetry(
      () => axios.post(agnes.baseUrl + agnes.i2vPath, reqBody, {
        headers: authHeaders(agnes), timeout: 180000,
      }),
      // agnes 视频模型免费用户 RPM=1（每分钟1个请求），提交偶发 429。
      // 429 后偶发的 400 实为限流副作用（同一请求体在其他段可成功）；
      // 但 400 也可能是请求体本身有问题（如图片格式/尺寸不符）。
      // 用 retryOn400 检查响应体：限流/容量类 → 重试（最多 2 次，退避 8s→16s）；
      // 请求体错误类 → 立即放弃，不再浪费 65 秒盲重试。
      // 实测提交阶段偶发 socket hang up / timeout（网络抖动，非限流），故提交 timeout 提到 180s、
      // 前端 COOLDOWN_MS=15000 保证段间隔 ≥15s。
      {
        label: `agnes i2v 提交(${agnes.i2vModel})`, jobId, step: 'video', retries: 2, baseDelayMs: 8000,
        retryOn400: (err) => {
          const d = err?.response?.data;
          const respBody = typeof d === 'string' ? d : JSON.stringify(d || {});
          // 限流 / 容量不足 / 服务过载类 400 → 可重试
          return /quota|rate.?limit|capacity|overload|busy|too many|限流|容量|繁忙|service unavailable|temporarily/i.test(respBody);
        }
      }
    );
  };

  let submit;
  try {
    submit = await submitRequest(body);
  } catch (err) {
    if (!isContentPolicyViolation(err)) throw err;
    // 内容审查拦截：渐进式净化提示词后重试（最多两级：标准净化 → 激进净化），仍失败才抛出（绝不降级 mock）。
    // i2v 的 negative_prompt 字段也可能被审查器做关键词匹配（如 "no extreme emotions"、
    // "no distorted faces" 中的 extreme/distorted 等词），故净化重试时直接移除最安全。
    // 两级净化与 t2i.js（1.1.28）对齐：标准净化替换常见触发词；激进净化额外移除 "wearing…" 服装从句、
    // 弱化 silk/satin 等材质词（silk 只在激进净化里被替换为 fabric，故仅一级净化对 silk 无效）。
    const levels = [sanitizeForContentPolicy, sanitizeForContentPolicyAggressive];
    let lastErr = err;
    for (const sanitizeFn of levels) {
      const sanitizedPrompt = sanitizeFn(body.prompt);
      if (sanitizedPrompt === body.prompt) continue; // 该级净化无变化，跳过
      try {
        log(jobId, 'warn', 'video', `content_policy_violation：净化提示词后重试（移除 negative_prompt + 替换敏感词）`);
        const sanitizedBody = { ...body, prompt: sanitizedPrompt, negative_prompt: undefined };
        submit = await submitRequest(sanitizedBody);
        break; // 净化重试成功
      } catch (e2) {
        if (!isContentPolicyViolation(e2)) throw e2; // 非内容审查错误直接抛出
        lastErr = e2;
      }
    }
    if (!submit) throw lastErr;
  }
  const sd = submit.data || {};
  // 新平台（api.agnes-ai.cn）提交后返回两个 ID：
  //   id / task_id —— 短任务 ID（task_xxx），用于「轮询进度」GET /v1/videos/{task_id}（无查询限流）
  //   video_id     —— 长 base64 ID（video_xxx），用于完成后「取下载链接」GET /agnesapi?video_id=
  // 旧平台（apihub，已下线）只用 video_id 直接轮询 /agnesapi；新平台 /agnesapi?video_id=<task_id> 会 404，
  // 故此处优先取 task_id 走「/v1/videos/{task_id} 轮询」新流程。
  const taskId = sd.id || sd.task_id || sd?.data?.id || sd?.data?.task_id || sd.video_id || sd?.data?.video_id;
  const submitVideoId = sd.video_id || sd?.data?.video_id || null;
  if (!taskId) throw new Error('agnes i2v 提交未返回任务 ID: ' + JSON.stringify(sd).slice(0, 300));
  log(jobId, 'info', 'video', `agnes 图生视频已提交，任务 ID=${taskId}`);
  setProgress(jobId, { phase: 'video', percent: 10, label: `图生视频已提交（第${index + 1}镜），等待服务端渲染…`, detail: `任务ID=${taskId}` });

  // 轮询进度：新平台用 GET {baseUrl}{i2vPath}/{task_id}（即 /v1/videos/{task_id}，经实测无查询限流，可稳定轮询）。
  // 注意：此端点完成后只返回 status=completed + video_id，**不含下载 url**，需再用 video_id 查 /agnesapi 取 url（见循环后）。
  const url = `${agnes.baseUrl}${agnes.i2vPath}/${encodeURIComponent(taskId)}`;
  let last = null;
  // 轮询间隔 15s：agnes 视频渲染实测常需 180~400s，8s 过密无意义且徒增 TLS 抖动概率；
  // 状态查询(GET)经实测不计入限流，拉长间隔更稳且几乎不影响拿到结果的时机。
  const pollIntervalMs = 15000;
  // 整体轮询上限：默认 30 分钟（实测单段可达 400s+，480s 曾误杀差一点就好的任务；2026-08-03 遇 1200s 仍超时，
  // 说明高峰期服务端渲染可能更久）。可用环境变量 I2V_MAX_WALL_MS 覆盖（毫秒）。
  const maxWallMs = Number(process.env.I2V_MAX_WALL_MS) > 0 ? Number(process.env.I2V_MAX_WALL_MS) : 30 * 60 * 1000;
  const maxNetErrors = 60;           // 连续网络错误上限（瞬时抖动可容忍，不消耗整体预算）
  let netErrors = 0;
  let attempt = 0;
  const tStart = Date.now();
  while (true) {
    if (Date.now() - tStart > maxWallMs) {
      // 超时前做最后一次状态查询，区分「仍在渲染」与「任务丢失」，并给出可操作的提示
      let finalStatus = 'unknown';
      let finalRaw = null;
      try {
        const f = await axios.get(url, { headers: authHeaders(agnes), timeout: 60000 });
        finalRaw = f.data;
        finalStatus = String(finalRaw?.status || finalRaw?.state || 'unknown');
      } catch (fe) {
        finalStatus = `查询失败(${fe?.message || fe})`;
      }
      if (['succeeded', 'completed', 'done', 'success', 'ready'].includes(finalStatus.toLowerCase())) {
        last = finalRaw; // 超时瞬间恰好完成，直接继续取链接
        log(jobId, 'warn', 'video', `i2v 轮询已超时但任务恰好完成（status=${finalStatus}），继续取下载链接`);
        break;
      }
      throw new Error(
        `agnes i2v 轮询超时（> ${maxWallMs / 1000}s），任务最终状态=${finalStatus}，任务ID=${taskId}` +
        (finalStatus.toLowerCase() === 'processing' || finalStatus.toLowerCase() === 'queued' || finalStatus.toLowerCase() === 'pending'
          ? '。任务仍在服务端渲染，可稍后重试，或调大环境变量 I2V_MAX_WALL_MS 增加等待上限。'
          : '。任务可能已丢失，请重试。')
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    attempt++;
    try {
      const r = await axios.get(url, { headers: authHeaders(agnes), timeout: 60000 });
      last = r.data;
      netErrors = 0; // 成功收到响应，重置连续网络错误计数
    } catch (pollErr) {
      // 轮询请求本身可能偶发网络抖动，记录警告并继续重试，不中断整个任务
      netErrors++;
      log(jobId, 'warn', 'video', `轮询请求异常（第 ${attempt} 次，连续 ${netErrors} 次），将重试：${pollErr.message}`);
      if (netErrors >= maxNetErrors) {
        throw new Error(`agnes i2v 轮询连续网络失败 ${netErrors} 次，放弃：${pollErr.message}`);
      }
      continue;
    }
    const term = isTerminal(last);
    if (term === 'failed') throw new Error('agnes i2v 任务失败: ' + JSON.stringify(last).slice(0, 300));
    if (term === 'done') {
      log(jobId, 'info', 'video', `agnes 图生视频完成（轮询 ${attempt} 次）`);
      break;
    }
    // 轮询期间按已用时估算进度（10%→90%），持续刷新心跳，避免界面误判卡死
    const elapsed = Date.now() - tStart;
    const est = Math.min(90, 10 + (elapsed / maxWallMs) * 80);
    setProgress(jobId, { percent: est, label: `图生视频渲染中（第${index + 1}镜）…`, detail: `已等待 ${Math.round(elapsed / 1000)}s / 上限 ${Math.round(maxWallMs / 1000)}s，status=${last?.status || last?.state || '?'}` });
    if (attempt % 6 === 0) log(jobId, 'info', 'video', `轮询中…（第 ${attempt} 次，status=${last?.status || last?.state || '?'}，已等待 ${Math.round(elapsed / 1000)}s）`);
  }
  // 取下载链接：
  //  - 旧平台 /agnesapi 轮询响应里直接带 url（findVideoUrl 命中）；
  //  - 新平台 /v1/videos/{task_id} 完成响应**不含 url**，只有 video_id —— 需再用该 video_id
  //    查 GET /agnesapi?video_id= 拿真正的 mp4 下载 url（agnesapi 查询有速率限制，仅在终态查一次）。
  let videoUrl = findVideoUrl(last);
  if (!videoUrl) {
    const completionVideoId = last?.video_id || last?.data?.video_id || submitVideoId;
    if (completionVideoId) {
      const pollUrl = `${pollBase(agnes)}${agnes.videoPollPath}?${agnes.videoPollParam}=${encodeURIComponent(completionVideoId)}`;
      const pr = await withAgnesRetry(
        () => axios.get(pollUrl, { headers: authHeaders(agnes), timeout: 60000 }),
        { label: 'agnes i2v 查询视频下载链接', jobId, step: 'video', retries: 5, baseDelayMs: 3000 }
      );
      videoUrl = findVideoUrl(pr.data);
    }
  }
  if (!videoUrl) throw new Error('agnes i2v 轮询完成但未找到视频 URL: ' + JSON.stringify(last).slice(0, 300));

  const dl = await withAgnesRetry(
    () => axios.get(videoUrl, { responseType: 'arraybuffer' }),
    { label: '下载 agnes 视频', jobId, step: 'video', retries: 5, baseDelayMs: 2000 }
  );
  fs.writeFileSync(outPath, Buffer.from(dl.data));
  log(jobId, 'info', 'video', `视频已下载 ${(dl.data?.length || 0)} bytes`);
  return outPath;
}

/** 由单张图生成一段视频。要求 Agnes 已启用；未启用或调用失败时直接抛错，绝不降级 mock 占位。 */
export async function generateVideo(outPath, imagePath, prompt, globalVideoPrompt = '', index = 0, agnes = null, jobId = null, orientation = 'landscape', negativePrompt = '') {
  const t0 = Date.now();
  const dirLabel = mediaSizes(orientation).orientation === 'portrait' ? '竖屏' : '横屏';
  if (!agnes?.enabled) {
    throw new Error('Agnes 未启用（缺少 API Key / Base URL），无法生成视频。请在设置中配置 Agnes 后重试。');
  }
  log(jobId, 'info', 'video', `请求 agnes 图生视频(${agnes.i2vModel}) 第${index + 1}镜（${dirLabel} ${mediaSizes(orientation).video.width}x${mediaSizes(orientation).video.height}）…`);
  const r = await realGenerate(agnes, outPath, imagePath, prompt, globalVideoPrompt, jobId, orientation, negativePrompt, index);
  const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  log(jobId, 'info', 'video', `✓ 真实视频已生成 第${index + 1}镜（${Date.now() - t0}ms, ${sz} bytes）`);
  return r;
}
