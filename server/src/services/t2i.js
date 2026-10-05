import fs from 'node:fs';
import axios from 'axios';
import { mediaSizes } from '../config.js';
import { log, timeStep } from '../logger.js';
import { withAgnesRetry, isContentPolicyViolation, sanitizeForContentPolicy, sanitizeForContentPolicyAggressive } from './agnesHttp.js';

// 表情约束负面词：用委婉正面表达替代直白触发词（crying/tears/sobbing 等），
// 避免 Agnes 内容审查过滤器做关键词匹配时误伤（即使写在 "Avoid:" 段里也会被拦截）。
const EXPR_NEG = 'serene composed expression, calm gentle demeanor, no extreme emotions, no exaggerated expressions, no distorted faces, no emotional outbursts';

function authHeaders(agnes) {
  const h = { 'Content-Type': 'application/json' };
  if (agnes.authType === 'x-api-key') h['X-API-Key'] = agnes.apiKey;
  else h['Authorization'] = `Bearer ${agnes.apiKey}`;
  return h;
}

// 参考图外貌描述缓存：同一张参考图（同一任务）只调用一次多模态视觉，后续镜复用。
const refDescCache = new Map();
function refKey(referenceImage) {
  // 用长度 + 起始片段做指纹，足以区分不同参考图，避免把整张 ~1.6MB 的 data URI 当 Map key。
  return `${referenceImage.length}:${referenceImage.slice(22, 60)}`;
}

/**
 * 用 Agnes 多模态视觉（文本/视觉模型）把参考角色图片读成英文外貌关键词。
 * Agnes 无 i2i/图像编辑端点（/v1/images/generations 的 image 字段会被静默忽略），
 * 因此改用「看图说话 → 注入外貌描述」的方式保证生成图贴合参考人物。
 * 出错抛异常，由调用方决定降级为无参考生成。
 */
async function describeReferenceImage(agnes, referenceImage, jobId) {
  const key = refKey(referenceImage);
  if (refDescCache.has(key)) {
    log(jobId, 'info', 'image', '复用已缓存的参考图外貌描述');
    return refDescCache.get(key);
  }
  const systemPrompt =
    'You are an expert at writing image-generation character descriptions from a photo. ' +
    'Look at the reference person and output ONLY a concise English description of the main person\'s ' +
    'appearance: gender, approximate age, face shape, hair (color/style/length), facial hair, ' +
    'eye shape/color, skin tone, and clothing (upper-body outfit and color). ' +
    'Do NOT describe background, pose, lighting, or mood. One paragraph, at most 60 words.';
  const userContent = [
    { type: 'text', text: 'Describe this person\'s exact appearance so an image model can keep them consistent.' },
    { type: 'image_url', image_url: { url: referenceImage } },
  ];
  const body = {
    model: agnes.chatModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 220,
  };
  const resp = await withAgnesRetry(
    () => axios.post(agnes.baseUrl + agnes.chatPath, body, {
      headers: authHeaders(agnes), timeout: 120000,
    }),
    { label: 'agnes 视觉描述参考图', jobId, step: 'image', retries: 3, baseDelayMs: 1500 }
  );
  const desc = resp?.data?.choices?.[0]?.message?.content?.trim() || '';
  if (!desc) throw new Error('参考图视觉描述返回为空');
  const refDesc =
    `The main character MUST look exactly like this reference person: ${desc}. ` +
    `Keep this character's face, hair, and clothing consistent across every shot.`;
  refDescCache.set(key, refDesc);
  log(jobId, 'info', 'image', `已生成参考图外貌描述（${desc.length} 字）`);
  return refDesc;
}

async function realGenerate(agnes, outPath, prompt, globalPrompt, orientation, jobId = null, negativePrompt = '', noCharacter = false, styleIds = [], shotSize = '', refDescription = '') {
  // agnes-image-2.1-flash（agnes-t2i-general-model）不支持 size 字段，竖/横屏比例改由提示词文字约束（见下方 aspectHint）。
  // agnes-image-2.1-flash 官方 API 不支持独立 negative_prompt 字段，
  // 因此把负面约束以 "Avoid: ..." 文本追加进正面提示词（prompt）中。
  let fullPrompt = `${globalPrompt}\n${prompt}`.trim();

  // 图生图（参考角色图片）：Agnes 无 i2i 端点，改用外貌描述注入，强约束主角长相一致。
  // 放在最前端，使其参与下方 hasPerson 判定（描述含 "character/person" 词），避免被自动纯景误杀。
  if (refDescription && !noCharacter) {
    fullPrompt = `${refDescription}\n${fullPrompt}`;
  }

  // 自动检测：prompt 中是否含人物相关描述
  const hasPerson = /\b(people|person|man|woman|boy|girl|human|figure|character|guy|lady|child|face|hair|wearing|dressed|portrait|silhouette|standing|sitting|walking|gazing|looking)\b|[\u4e00-\u9fff]*(人|男|女|角色|人物|主角|身影|穿着|头发|面孔|脸部|他|她|独处|群像|双人)/i;

  if (noCharacter) {
    // 用户强制纯景：无论提示词写了什么，移除人物相关词，追加纯景指令
    fullPrompt = fullPrompt
      .split(/\s+/).filter(w => !/^(people|person|man|woman|boy|girl|human|figure|character|guy|lady|child|face|hair|wearing|dressed|portrait|silhouette|standing|sitting|walking|gazing|looking)$/i.test(w))
      .join(' ');
    fullPrompt = `pure scenery, landscape photography, no humans, ` + fullPrompt;
    negativePrompt = `no humans, no characters, no people, no portraits, no faces` + (negativePrompt ? `, ${negativePrompt}` : '');
  } else if (!hasPerson.test(fullPrompt)) {
    // 自动检测：提示词中无人物描述 → 自动转为纯景处理
    log(jobId, 'info', 'image', '检测到无人物提示词，自动启用纯景模式');
    negativePrompt = `no humans, no characters, no people` + (negativePrompt ? `, ${negativePrompt}` : '');
  }

  // 人物特写皮肤柔化：仅当用户指定画风含「电影写真(cinematic)」或「油画(oil)」，
  // 且该镜为人物特写（景别元数据或 prompt 中含 close-up / 特写），且确实含人物时，
  // 追加皮肤柔化正面描述 + 负面瑕疵排除，避免痘痘/皱纹/毛孔过度写实锐利。
  const SKIN_STYLES = ['cinematic', 'oil'];
  const isSkinStyle = Array.isArray(styleIds) && styleIds.some((id) => SKIN_STYLES.includes(id));
  const closeUpByMeta = /特写|大特写|close[- ]?up|extreme close/i.test(shotSize || '');
  const closeUpByPrompt = /(extreme\s+)?close[- ]?up|大特写/i.test(fullPrompt);
  const isCloseUp = closeUpByMeta || closeUpByPrompt;
  if (isSkinStyle && isCloseUp && hasPerson.test(fullPrompt) && !noCharacter) {
    const retouchEn = 'smooth soft skin, flawless porcelain complexion, gentle beauty retouching, softened facial skin texture, subtle gaussian blur on skin, no visible pores, remove blemishes and wrinkles';
    fullPrompt += `\n${retouchEn}`;
    negativePrompt = `${negativePrompt ? negativePrompt + ', ' : ''}acne, skin blemishes, pimples, wrinkles, harsh skin pores, hyper-detailed skin texture, skin imperfections`;
    log(jobId, 'info', 'image', '电影写真/油画 人物特写：已注入皮肤柔化');
  }

  // 表情约束：即使 LLM 在 prompt 中写了哭泣/叹气等极端表情词，负面提示词也会兜底排除。
  // 仅当画面含人物时追加（纯景不需要表情约束）。
  // 注意：EXPR_NEG 已使用委婉表达（避免 crying/tears 等直白触发词被内容审查拦截）。
  if (!noCharacter && hasPerson.test(fullPrompt)) {
    negativePrompt = negativePrompt ? `${negativePrompt}, ${EXPR_NEG}` : EXPR_NEG;
  }

  // 1.1.37：通用画质负向兜底（全画风安全，对抗"粗糙感/模糊/伪影"）。
  // 仅排除模糊、低清、变形、压缩伪影等明显劣化，不触碰任何画风特征词，绝不与油画/动漫等风格冲突。
  const QUALITY_NEG = 'blurry, low resolution, low quality, deformed, disfigured, artifacts, jpeg artifacts, muddy texture, oversaturated noise';
  negativePrompt = negativePrompt ? `${negativePrompt}, ${QUALITY_NEG}` : QUALITY_NEG;

  fullPrompt += (negativePrompt ? `\nAvoid: ${negativePrompt}` : '');

  // agnes-image-2.1-flash（agnes-t2i-general-model）**不支持 size 字段**：实测带 size 会让端点挂起/返回 400。
  // 竖/横屏比例改用文字约束注入提示词，由模型自行决定输出尺寸（统一返回 URL，再下载）。
  const aspectHint = orientation === 'portrait'
    ? 'Vertical composition, 9:16 portrait aspect ratio, shot framed for a phone screen.'
    : 'Horizontal composition, 16:9 landscape aspect ratio, widescreen framing.';
  fullPrompt += `\n${aspectHint}`;

  // 注意：不再把参考图塞进 body.image —— Agnes 文生图端点会静默忽略该字段（返回 200 但无效）。
  // 参考图已通过 refDescription 以文字外貌描述注入到 fullPrompt 最前端（见上方）。

  // 内容审查拦截处理：若收到 content_policy_violation，净化提示词后重试一次。
  // 净化策略：① 移除 Avoid 段（负面词可能含触发词）→ ② 替换常见敏感词为委婉同义词。
  const callAgnes = async (promptText) => {
    const b = { model: agnes.t2iModel, prompt: promptText, n: 1 };
    const resp = await withAgnesRetry(
      () => axios.post(agnes.baseUrl + agnes.t2iPath, b, {
        headers: authHeaders(agnes), timeout: 180000,
      }),
      { label: `agnes t2i(${agnes.t2iModel})${refDescription ? ' 参考图' : ''}`, jobId, step: 'image', retries: 8, baseDelayMs: 2500, maxDelayMs: 45000 }
    );
    return resp;
  };

  const processResp = async (resp) => {
    const data = resp.data;
    const item = data?.data?.[0] || data?.images?.[0] || data?.image || null;
    if (item?.b64_json) {
      fs.writeFileSync(outPath, Buffer.from(item.b64_json, 'base64'));
    } else if (item?.url) {
      const r = await withAgnesRetry(
        () => axios.get(item.url, { responseType: 'arraybuffer' }),
        { label: '下载 agnes 图片', jobId, step: 'image', retries: 5, baseDelayMs: 2000 }
      );
      fs.writeFileSync(outPath, Buffer.from(r.data));
    } else {
      throw new Error('agnes t2i 返回无法解析: ' + JSON.stringify(data).slice(0, 300));
    }
    return outPath;
  };

  try {
    const resp = await callAgnes(fullPrompt);
    return await processResp(resp);
  } catch (err) {
    if (!isContentPolicyViolation(err)) throw err;
    // 内容审查拦截：渐进式净化提示词后重试（最多两级：标准净化 → 激进净化）。
    // 仍失败才抛出（绝不降级 mock 占位）。第18镜曾因 "slip dress"+"sheer" 未被净化词表覆盖而永久 400，
    // 两级净化可自愈此类确定性内容违规。
    const levels = [sanitizeForContentPolicy, sanitizeForContentPolicyAggressive];
    let lastErr = err;
    for (const sanitizeFn of levels) {
      const sanitized = sanitizeFn(fullPrompt);
      if (sanitized === fullPrompt) continue; // 该级净化无变化，跳过
      try {
        log(jobId, 'warn', 'image', `content_policy_violation：净化提示词后重试（移除敏感词）`);
        const resp2 = await callAgnes(sanitized);
        return await processResp(resp2);
      } catch (e2) {
        if (!isContentPolicyViolation(e2)) throw e2; // 非内容审查错误直接抛出
        lastErr = e2;
      }
    }
    throw lastErr;
  }
}

/** 生成单张分镜图。要求 Agnes 已启用；未启用或调用失败时直接抛错，绝不降级 mock 占位。
 * @param {boolean} [noCharacter=false] 纯景模式：加 "no humans" negative prompt
 * @param {string|null} [referenceImage=null] 图生图参考角色图片（base64 data URI）
 */
export async function generateImage(outPath, prompt, globalPrompt = '', index = 0, agnes = null, jobId = null, orientation = 'landscape', negativePrompt = '', noCharacter = false, referenceImage = null, styleIds = [], shotSize = '', characterLock = '') {
  const done = timeStep(jobId, 'image', `文生图 第${index + 1}镜（${mediaSizes(orientation).orientation === 'portrait' ? '竖屏' : '横屏'}）`);
  if (!agnes?.enabled) {
    throw new Error('Agnes 未启用（缺少 API Key / Base URL），无法生成图片。请在设置中配置 Agnes 后重试。');
  }
  log(jobId, 'info', 'image', `请求 agnes 文生图(${agnes.t2iModel}) 第${index + 1}镜，比例 ${orientation === 'portrait' ? '竖屏 9:16' : '横屏 16:9'}（比例由提示词约束，不传 size 字段）…`);
  // 解析参考图外貌描述：同一任务同一张图只调一次多模态视觉，失败则降级为无参考生成（仍为真实生成，非 mock）。
  let refDescription = '';
  if (referenceImage && !noCharacter && typeof referenceImage === 'string' && referenceImage.startsWith('data:image/')) {
    try {
      refDescription = await describeReferenceImage(agnes, referenceImage, jobId);
    } catch (e) {
      log(jobId, 'error', 'image', `参考图外貌识别失败，改用无参考生成：${e.message}`);
    }
  }
  // 1.1.41 方案 F：无参考图时用 characterLock（来自 resolveSubject 的角色描述）注入 prompt 最前端
  // 确保即使无参考图，每镜 t2i 也能看到相同的角色描述
  const effectiveRefDesc = refDescription || (!noCharacter && characterLock ? `The main character: ${characterLock}. Keep this character's face, hair, and clothing consistent.` : '');
  const r = await realGenerate(agnes, outPath, prompt, globalPrompt, orientation, jobId, negativePrompt, noCharacter, styleIds, shotSize, effectiveRefDesc);
  const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  done(true, `真实图片 ${sz} bytes`);
  return r;
}
