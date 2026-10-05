import axios from 'axios';
import { withAgnesRetry } from './agnesHttp.js';
import { log } from '../logger.js';

function authHeaders(agnes) {
  const h = { 'Content-Type': 'application/json' };
  if (agnes.authType === 'x-api-key') h['X-API-Key'] = agnes.apiKey;
  else h['Authorization'] = `Bearer ${agnes.apiKey}`;
  return h;
}

/** 调用 agnes Chat（OpenAI 兼容）。agnes 必须已启用。带瞬时错误重试 + 限流防护。 */
export async function chatCompletion(agnes, messages, { temperature = 0.8, json = false, jobId = null, retries = 5, timeout = 150000, baseDelayMs = null } = {}) {
  if (!agnes?.enabled) throw new Error('AGNES 未启用（缺少 baseUrl / apiKey）');
  const body = { model: agnes.chatModel, messages, temperature, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  const resp = await withAgnesRetry(
    () => axios.post(agnes.baseUrl + agnes.chatPath, body, {
      headers: authHeaders(agnes),
      // 超时设 150s：agnes 在限流/过载时常把请求挂入队列而不直接返 429，
      // 超时过久（如 180s）会让单次请求卡死、再叠加 5 次重试 => 整步长达 15 分钟。
      // 收紧到 150s 可更快触发退避、加速恢复。
      timeout,
    }),
    {
      label: `agnes chat(${agnes.chatModel})`, jobId, step: 'storyboard',
      retries,
      // 比默认 2s 略高：chat 是较重端点，限流后稍长的基准退避更稳妥。
      // 调用方可在 options 里用 baseDelayMs 覆盖（分镜分批生成时为 6000ms，给过载的 agnes 更多喘息）。
      baseDelayMs: baseDelayMs != null ? baseDelayMs : 3000,
      // 429 后偶发的 400/408 常为限流副作用（同一请求体在重试后往往成功），
      // 与 i2v 一致纳入可重试集；纯 400（请求体本身错误）极少见，且 withAgnesRetry
      // 会在耗尽重试后放弃，不会无限循环。
      extraRetryStatus: new Set([400, 408]),
    }
  );
  return extractChatText(resp.data, jobId);
}

/** 从模型返回中解析 JSON（去除 ```json 围栏） */
export function parseJSON(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

/**
 * 从 agnes Chat 的响应体里提取「可作为文本解析」的字段。
 * 优先 message.content；当 content 为空（Agnes 文本模型偶发把 JSON 放进 reasoning_content 而非 content，
 * 表现为 content=""、finish_reason="stop"）时回退到 reasoning_content，避免误判为结构无法解析而熔断整轮兜底。
 */
export function extractChatText(data, jobId = null) {
  const msg = data?.choices?.[0]?.message;
  const content = msg?.content;
  const reasoning = msg?.reasoning_content;
  if (content && String(content).trim()) return content;
  if (reasoning && String(reasoning).trim()) {
    if (jobId) log(jobId, 'warn', 'storyboard', 'agnes 返回的 message.content 为空，已回退使用 reasoning_content 解析（Agnes 文本模型偶发行为）');
    return reasoning;
  }
  if (data?.output) return data.output;
  if (typeof data === 'string') return data;
  throw new Error('agnes chat 返回结构无法解析: ' + JSON.stringify(data).slice(0, 300));
}
