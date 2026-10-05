/**
 * 1.1.40 内容质量校验测试
 * 验证 normalize 的新增内容质量校验能拦截：
 *   1) imagePrompt 为空（截断自愈丢字段）
 *   2) imagePrompt 仅含风格词（截断在风格前缀后）
 *   3) caption/imagePrompt 为占位符 "..."（抢救返回占位符）
 *   4) imagePrompt 过短
 *   5) imagePrompt 长度达标但全是风格词（无场景指示词）
 * 同时验证正常段不被误杀。
 */
import { normalize } from './server/src/services/storyboard.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}: ${e.message}`);
    fail++;
  }
}

// 正常段（有完整场景+人物描述）
const normalSeg = {
  shot: 1,
  caption: '推镜头：湿漉漉的都市街道，霓虹灯在水洼中投下破碎的蓝紫与琥珀倒影。主角独自坐在台阶边缘。',
  imagePrompt: 'cinematic photography, film still, anamorphic lens, dramatic chiaroscuro lighting, photorealistic, 35mm film grain, shallow depth of field, A beautiful Chinese woman with long black hair sitting alone on wet stone steps, neon reflections in puddles, blue-purple and amber tones, rain-soaked city street at night',
};

// 异常段1：imagePrompt 为空（截断自愈丢字段）
const emptyImgSeg = {
  shot: 6,
  caption: '摇镜头：湿漉漉的都市街道，霓虹灯在水洼中投下破碎的蓝紫与琥珀倒影。主角独自坐在台阶边缘。',
  imagePrompt: '',
};

// 异常段2：imagePrompt 仅含风格词（截断在风格前缀后，139字符 < 150）
const styleOnlySeg = {
  shot: 6,
  caption: '摇镜头：湿漉漉的都市街道，霓虹灯在水洼中投下破碎的蓝紫与琥珀倒影。',
  imagePrompt: 'cinematic photography, film still, anamorphic lens, dramatic chiaroscuro lighting, photorealistic, 35mm film grain, shallow depth of field,',
};

// 异常段3：caption 和 imagePrompt 都是占位符 "..."（抢救返回占位符）
const placeholderSeg = {
  shot: 17,
  caption: '...',
  imagePrompt: '...',
};

// 异常段4：imagePrompt 过短（< 150 字符）
const shortImgSeg = {
  shot: 3,
  caption: '正常的字幕描述，长度足够。',
  imagePrompt: 'A woman in a garden.',
};

// 异常段5：imagePrompt 有 150+ 字符但全是风格词（无场景指示词）
const styleOnlyLongSeg = {
  shot: 5,
  caption: '正常的字幕描述，长度足够通过 caption 校验。',
  imagePrompt: 'cinematic photography, film still, anamorphic lens, dramatic chiaroscuro lighting, photorealistic, 35mm film grain, shallow depth of field, soft volumetric light, cool muted atmosphere, dramatic lighting, photorealistic, shallow depth of field, soft focus, gentle volumetric light, color graded, bokeh, vintage film, grainy',
};

console.log('=== 内容质量校验测试 ===');

// 正常段应通过
check('正常段（完整场景+人物）通过校验', () => {
  const board = { segments: [{ ...normalSeg }] };
  normalize(board, 1);
});

// 异常段1：imagePrompt 为空 → 抛异常
check('imagePrompt 为空 → 抛异常', () => {
  const board = { segments: [{ ...emptyImgSeg }] };
  let threw = false;
  try { normalize(board, 1); } catch (e) { threw = /imagePrompt 内容过短/.test(e.message); }
  if (!threw) throw new Error('未抛出 imagePrompt 内容过短 异常');
});

// 异常段2：imagePrompt 仅含风格词(短) → 抛异常（长度不足或无场景词）
check('imagePrompt 仅含风格词(短) → 抛异常', () => {
  const board = { segments: [{ ...styleOnlySeg }] };
  let threw = false;
  try { normalize(board, 1); } catch (e) { threw = /imagePrompt/.test(e.message); }
  if (!threw) throw new Error('未抛出 imagePrompt 相关异常');
});

// 异常段3：caption 和 imagePrompt 都是 "..." → 抛异常
check('caption="..." → 抛异常', () => {
  const board = { segments: [{ ...placeholderSeg }] };
  let threw = false;
  try { normalize(board, 1); } catch (e) { threw = /caption 内容缺失/.test(e.message); }
  if (!threw) throw new Error('未抛出 caption 内容缺失 异常');
});

// 异常段4：imagePrompt 过短 → 抛异常
check('imagePrompt 过短(<150) → 抛异常', () => {
  const board = { segments: [{ ...shortImgSeg }] };
  let threw = false;
  try { normalize(board, 1); } catch (e) { threw = /imagePrompt 内容过短/.test(e.message); }
  if (!threw) throw new Error('未抛出 imagePrompt 内容过短 异常');
});

// 异常段5：imagePrompt 150+ 字符但全是风格词 → 抛异常（场景指示词检测）
check('imagePrompt 全是风格词(长) → 抛异常', () => {
  const board = { segments: [{ ...styleOnlyLongSeg }] };
  let threw = false;
  try { normalize(board, 1); } catch (e) { threw = /缺少场景\/人物描述|仅有风格词/.test(e.message); }
  if (!threw) throw new Error('未抛出 缺少场景/人物描述 异常');
});

// 多段混合：正常+异常 → 抛异常
check('多段混合(正常+异常) → 抛异常', () => {
  const board = { segments: [{ ...normalSeg }, { ...emptyImgSeg }] };
  let threw = false;
  try { normalize(board, 2); } catch (e) { threw = /imagePrompt/.test(e.message); }
  if (!threw) throw new Error('未抛出异常');
});

console.log(`\n===== test_content_quality: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail > 0 ? 1 : 0);
