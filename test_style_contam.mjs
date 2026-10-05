// 1.1.37 风格隔离回归测试：验证黑名单变体补全 + 空 styleIds 不清理漏洞修复
import { applyStylesToStoryboard } from './server/src/services/storyboard.js';
import { getStyles, foreignStyleTokens, stylePromptEn, stylePromptZh } from './server/src/services/styles.js';

// 被严重污染的 LLM 输出：电影感默认词 + 各类近义词变体 + 油画变体 + 其它画风词
const contaminatedEn =
  'cinematic photography, film still, anamorphic lens, 35mm film grain, 35mm, photorealistic, shallow depth of field, ' +
  'cinematic atmosphere, cinematic tone, cinematic composition, anamorphic lens flare, filmic, moody lighting, color graded, bokeh, vintage film, grainy, ' +
  'classical oil painting, oil painting, oil on canvas, visible brushwork, thick paint, canvas texture, heavy impasto, oil paint, palette knife, old master, chiaroscuro, painterly, impressionist, museum quality, ' +
  'japanese anime key visual, cel shading, chinese traditional aesthetics, hanfu, cyberpunk neon lit megacity, soft watercolor illustration, chinese ink wash painting, flat cartoon style, high quality 3d render octane render, cg animated film pixar, hong kong retro anime';
const contaminatedZh =
  '电影写真感、胶片质感、宽银幕镜头、戏剧性光影、写实、电影感、电影氛围、电影色调、电影叙事、电影画面、' +
  '油画、油画风格、油画质感、油画笔触、油画感、画布肌理、厚重笔触、明暗对比、古典质感、印象派笔触、印象派、胶片颗粒、宽银幕、写实风格、写实摄影、' +
  '日式动漫、赛璐璐上色、中国风、汉服、赛博朋克、霓虹都市、水彩、水墨、粗描边、3D渲染、CG动画、港风动漫';

const mkSeg = (i) => ({
  shot: i + 1,
  imagePrompt: contaminatedEn, imagePromptZh: contaminatedZh,
  videoPrompt: contaminatedEn, videoPromptZh: contaminatedZh,
  caption: '第' + (i + 1) + '镜 测试',
});
const mkBoard = () => ({
  visualBible: '整体风格：电影感。' + contaminatedZh,
  globalPrompt: contaminatedEn, globalPromptZh: contaminatedZh,
  globalVideoPrompt: contaminatedEn, globalVideoPromptZh: contaminatedZh,
  segments: [mkSeg(0), mkSeg(1), mkSeg(2)],
});

// 所有画风的特征词全集
const ALL_TOKENS = foreignStyleTokens([]); // 传空数组得到全部画风 token
function collectTexts(out) {
  return [out.globalPrompt, out.globalPromptZh, out.globalVideoPrompt, out.globalVideoPromptZh, out.visualBible,
    ...out.segments.flatMap((s) => [s.imagePrompt, s.imagePromptZh, s.videoPrompt, s.videoPromptZh])];
}
// 先剥掉所选画风自身的 en/zh 前缀（这些是该画风定义、不是污染），再扫描 LLM 残留内容里是否还有"非选中画风"特征词
function stripOwnPrefix(text, styleIds) {
  let t = text || '';
  const en = stylePromptEn(styleIds);
  const zh = stylePromptZh(styleIds);
  if (en) t = t.split(en).join('');
  if (zh) t = t.split(zh).join('');
  return t;
}
function findSurvivors(text, styleIds) {
  const selectedTokens = new Set((getStyles(styleIds)[0]?.signatureTokens || []).map((x) => x.toLowerCase()));
  const t = stripOwnPrefix(text, styleIds).toLowerCase();
  return ALL_TOKENS.filter((tok) => !selectedTokens.has(tok.toLowerCase()) && t.includes(tok.toLowerCase()));
}

let failures = 0;
function report(label, styleIds, keepStyleId) {
  const out = applyStylesToStoryboard(mkBoard(), styleIds);
  const survivors = new Set();
  for (const t of collectTexts(out)) for (const s of findSurvivors(t, styleIds)) survivors.add(s);
  console.log(`\n=== ${label} (styleIds=${JSON.stringify(styleIds)}) ===`);
  if (survivors.size === 0) console.log('  ✓ 无跨风格污染残留');
  else { console.log('  ✗ 残留: ' + [...survivors].join(' | ')); failures++; }
  return out;
}

// 1) 各非电影/非油画画风：必须零残留（foreign 已覆盖所有未选中画风，包括电影/油画变体）
for (const sid of ['anime', 'inkwash', 'chinese', 'render3d', 'cyberpunk', 'cartoon', 'watercolor', 'hkanime', 'cganime']) {
  report('选 ' + sid, [sid], sid);
}

// 2) 选油画：油画词必须保留，但其它画风（含电影/动漫）必须消失
const oilOut = report('选 oil', ['oil'], 'oil');
const oilKept = (oilOut.segments[0].imagePrompt + ' ' + oilOut.globalPrompt).toLowerCase().includes('oil');
console.log(oilKept ? '  ✓ 油画特征已保留' : '  ✗ 油画特征被误删');
if (!oilKept) failures++;

// 3) 选电影写真：电影词必须保留，油画/动漫等必须消失
const cineOut = report('选 cinematic', ['cinematic'], 'cinematic');
const cineKept = (cineOut.segments[0].imagePrompt + ' ' + cineOut.globalPrompt).toLowerCase().includes('cinematic');
console.log(cineKept ? '  ✓ 电影写真特征已保留' : '  ✗ 电影写真特征被误删');
if (!cineKept) failures++;

// 4) 空 styleIds（默认/未选画风）：油画/动漫等痕迹必须被清理（此前完全不清理 → 漏洞），电影感可保留
const emptyOut = applyStylesToStoryboard(mkBoard(), []);
const emptyTexts = [emptyOut.globalPrompt, emptyOut.segments[0].imagePrompt, emptyOut.visualBible];
const emptyOil = emptyTexts.some((t) => /oil|油画|油画风格|画布肌理/i.test(t || ''));
const emptyAnime = emptyTexts.some((t) => /anime|日式动漫|赛璐璐/i.test(t || ''));
console.log(`\n=== 空 styleIds（默认电影感路径）===`);
console.log(!emptyOil ? '  ✓ 油画痕迹已清理' : '  ✗ 油画痕迹残留');
console.log(!emptyAnime ? '  ✓ 其它画风痕迹已清理' : '  ✗ 其它画风痕迹残留');
if (emptyOil || emptyAnime) failures++;
// 空 styleIds 时不应残留前缀 ", "
const noLeadingComma = !emptyOut.globalPrompt.startsWith(', ') && !emptyOut.segments[0].imagePrompt.startsWith(', ');
console.log(noLeadingComma ? '  ✓ 无残留 ", " 前缀' : '  ✗ 存在残留 ", " 前缀');
if (!noLeadingComma) failures++;

console.log(`\n总判定：${failures === 0 ? '✓ 风格隔离全部通过' : '✗ 存在 ' + failures + ' 项缺陷'}`);
process.exit(failures === 0 ? 0 : 1);
