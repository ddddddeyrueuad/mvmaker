import { log } from '../logger.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 瞬时（可重试）的错误：网络抖动、连接重置、DNS、TLS 握手、限流(429)、服务端 5xx。
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED',
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
]);

export function isTransientError(err) {
  if (!err) return false;
  const code = err.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = String(err.message || '');
  if (/socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|network is down|network error|getaddrinfo|tunneling socket/i.test(msg)) return true;
  if (/SSL|TLS|certificate|handshake|DEPTH_ZERO|SELF_SIGNED/i.test(msg)) return true;
  const status = err.response?.status;
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) return true;
  return false;
}

/**
 * 对 agnes 请求做「指数退避重试」，仅对瞬时错误重试；致命错误（4xx 除 429/408、解析失败）立即抛出。
 * - 429 会读取 Retry-After 头，至少等待其指定的秒数。
 * - 每次重试以 warn 级别记录，便于在后端日志看到。
 */
export async function withAgnesRetry(fn, {
  label = 'agnes 请求', jobId = null, step = 'agnes',
  retries = 5, baseDelayMs = 2000, maxDelayMs = 30000,
  extraRetryStatus = null,
  retryOn400 = null,
} = {}) {
  // 调用方可把某些"非标准瞬时"状态码也视为可重试（例如 agnes 图生视频在 429 限流后
  // 偶发返回 400，实为限流副作用而非请求体错误）。默认不扩展。
  const extra = extraRetryStatus instanceof Set ? extraRetryStatus : null;
  const isExtraRetry = (err) => {
    if (!extra) return false;
    const st = err?.response?.status;
    return st != null && extra.has(st);
  };

  // 对 400 做更精细的分类：若调用方提供了 retryOn400 回调，则由回调决定是否重试
  // （回调可检查响应体内容区分"限流副作用"与"请求体错误"）；否则回退到 extraRetryStatus 旧行为。
  const shouldRetry400 = (err) => {
    if (err?.response?.status !== 400) return false;
    if (typeof retryOn400 === 'function') return retryOn400(err);
    return extra && extra.has(400);
  };

  // 提取 400 响应体摘要（用于日志诊断）
  const errBody400 = (err) => {
    const d = err?.response?.data;
    if (!d) return '(empty)';
    return typeof d === 'string' ? d.slice(0, 200) : JSON.stringify(d).slice(0, 200);
  };

  let attempt = 0;
  let lastErr;
  while (true) {
    const tAttempt = Date.now();
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const is400 = err?.response?.status === 400;
      const retry400 = is400 && shouldRetry400(err);

      if (is400) {
        // 400 且 retryOn400 判定为"不重试" → 立即抛出（请求体本身有问题）
        if (!retry400) {
          log(jobId, 'error', step, `${label} 收到 400（请求体错误，不重试）：${err.message} | 响应体: ${errBody400(err)}`);
          throw err;
        }
        // 400 且判定为"限流副作用" → 重试，但记录响应体供诊断
        log(jobId, 'warn', step, `${label} 收到 400（判定为限流副作用，将重试）| 响应体: ${errBody400(err)}`);
      } else if (!isTransientError(err) && !isExtraRetry(err)) {
        log(jobId, 'error', step, `${label} 失败（非瞬时错误，不重试）：${err.message}`);
        throw err;
      }
      if (isExtraRetry(err) && !is400 && !isTransientError(err)) {
        log(jobId, 'warn', step, `${label} 收到可重试状态码 ${err.response?.status}，将作为限流副作用重试`);
      }
      attempt++;
      if (attempt > retries) {
        log(jobId, 'error', step, `${label} 连续重试 ${retries} 次后放弃：${err.message}`);
        throw err;
      }
      const elapsed = Date.now() - tAttempt;
      let delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const status = err.response?.status;
      const retryAfter = err.response?.headers && (err.response.headers['retry-after'] || err.response.headers['Retry-After']);
      if (status === 429 && retryAfter != null) {
        const sec = Number.parseInt(retryAfter, 10);
        if (!Number.isNaN(sec)) delay = Math.max(delay, sec * 1000);
      }
      const jitter = Math.floor(Math.random() * 600);
      // 明确区分「超时」与「瞬时网络错误」，并在日志里带上本次耗时，便于判断 agnes 是真慢还是被重置
      const isTimeout = /timeout/i.test(err.message) || err.code === 'ECONNABORTED';
      const kind = isTimeout ? '超时' : '瞬时网络';
      log(jobId, 'warn', step, `${label} ${kind}错误（第 ${attempt}/${retries} 次，本次耗时 ${elapsed}ms），${delay + jitter}ms 后重试：${err.message}`);
      await sleep(delay + jitter);
    }
  }
}

/**
 * 检测 400 错误是否为内容审查拦截（content_policy_violation）。
 * 兼容 t2i 格式 {"error":{"code":"content_policy_violation",...}}
 * 和 i2v 格式 {"code":"content_policy_violation","message":"...","data":null}。
 */
export function isContentPolicyViolation(err) {
  if (err?.response?.status !== 400) return false;
  const d = err?.response?.data;
  const body = typeof d === 'string' ? d : JSON.stringify(d || {});
  return /content_policy_violation|content.policy|unable to generate this content/i.test(body);
}

/**
 * 净化提示词以绕过内容审查：
 * 1. 移除 "Avoid:" 负面段（可能含触发词）；
 * 2. 替换常见触发词为委婉同义词。
 */
export function sanitizeForContentPolicy(prompt) {
  // 移除 Avoid: 段
  let s = prompt.replace(/\nAvoid:.*$/s, '');
  // 替换常见触发词（不区分大小写）
  s = s
    .replace(/\b(crying|tearful|tears|sobbing|sobbed|sobs|weeping|wept|wail|wailing|wailed)\b/gi, 'serene')
    .replace(/\b(sigh|sighing|sighed)\b/gi, 'calm')
    .replace(/\b(blood|bloody|bleeding|wound|wounded|injury|injured)\b/gi, 'shadow')
    .replace(/\b(kill|killed|killing|kills)\b/gi, 'stillness')
    .replace(/\b(death|dead|die|died|dying)\b/gi, 'tranquility')
    .replace(/\b(weapon|gun|knife|sword|blade|dagger)\b/gi, 'object')
    .replace(/\b(fight|fighting|fought|combat|battle|war)\b/gi, 'movement')
    .replace(/\b(nude|naked|nsfw)\b/gi, 'elegant')
    .replace(/\b(isolation|isolated|isolating)\b/gi, 'solitude')
    .replace(/\b(distorted|extreme|outbursts?)\b/gi, 'gentle')
    // 忧郁/哀伤类情绪词（第2镜 "melancholic room"、第3镜 "sorrowful expression" 即此类，视频模型会拦截）
    .replace(/\b(melancholic|melancholy|sorrowful|sorrow|sorrowing|mournful|mourning|gloomy|gloom|somber|forlorn|desolate|desolation|anguished|anguish|woeful|doleful|lugubrious)\b/gi, 'contemplative')
    // 图片内容审查常见触发词（服装/材质类，易被判定为暗示性）：第18镜 "slip dress"+"sheer shawl" 即此类
    .replace(/\b(slip\s*dress|slip)\b/gi, 'dress')
    .replace(/\b(sheer)\b/gi, 'light')
    .replace(/\b(lingerie)\b/gi, 'apparel')
    .replace(/\b(bikini)\b/gi, 'swimsuit')
    .replace(/\b(cleavage)\b/gi, 'neckline')
    .replace(/\b(lace)\b/gi, 'fabric')
    .replace(/\b(crop\s*top|croptop)\b/gi, 'top')
    .replace(/\b(miniskirt|mini\s*skirt)\b/gi, 'skirt')
    .replace(/\b(see[\s-]*through|transparent)\b/gi, 'delicate')
    .replace(/\b(leather|latex|fishnet)\b/gi, 'fabric')
    .replace(/\b(thong|panties|bra|underwear)\b/gi, 'undergarment');
  return s;
}

/**
 * 激进净化：标准净化之上，再移除服装/外貌敏感描述从句（"wearing …" / "dressed in …"），
 * 并弱化剩余材质/版型暗示词。用于标准净化仍被内容审查拦截时的二次尝试。
 * 仅调整提示词使其合规，不降级 mock。
 */
export function sanitizeForContentPolicyAggressive(prompt) {
  let s = sanitizeForContentPolicy(prompt);
  // 移除 "wearing a … shawl draped over her arms，" 这类服装描述从句（到下一个逗号为止）
  s = s.replace(/[，,]?\s*(wearing|wears|dressed in|clad in)[^，,]+/gi, '');
  // 再次清理可能的残留触发词
  s = s
    .replace(/\b(silk|satin|velvet)\b/gi, 'fabric')
    .replace(/\b(skin[\s-]*tight|tight[\s-]*fitting)\b/gi, 'flowing')
    .replace(/\b(low[\s-]*cut|low[\s-]*rise|plunging)\b/gi, 'modest')
    .replace(/\b(revealing|suggestive)\b/gi, 'elegant');
  return s;
}
