// 离线单测：全局故事大纲（beat sheet）1.1.36
// 验证：确定性 beats 行走受控(非纯景/不连续/比例≤40%/不全走)、地点多样、幕弧存在、纯景用环境动作；
//       buildUserPrompt 正确注入 beat 约束；buildStoryPlan 在无 agnes 时回落确定性编排。
import assert from 'node:assert';
import { composeDeterministicBeats, buildStoryPlan, buildUserPrompt } from './server/src/services/storyboard.js';

const ENV_WORDS = ['风动', '雨点', '光线沿墙', '花瓣飘落', '日影渐长'];

function makeAnalysis(N) {
  return {
    overall: { genre: 'Cinematic Orchestral', mood: 'melancholic', moodZh: '忧郁', tempoBpm: 140, energy: 0.6, loudness: -18 },
    segments: Array.from({ length: N }, (_, i) => ({
      index: i, startTime: i * 10, energy: 0.4 + 0.08 * i, brightness: 0.5,
      mood: 'melancholic', moodZh: '忧郁', motion: 'slow pan',
    })),
  };
}
const CASTS = ['纯景/无人物（空镜头，不含任何人物）', '主角独处', '主角独处', '双人/第二人物（歌词涉及他人）', '主角独处', '群像/人群（歌词涉及群体）'];

let pass = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('A. composeDeterministicBeats（确定性编排）');
check('返回 N=6 个 beat', () => {
  const b = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  assert.strictEqual(b.beats.length, 6);
});
// 行走受控：允许叙事性行走，但纯景不行走、不得连续、比例≤40%、且不能整片皆走
const WALK_RE = /walk|走|徒步|行步/i;
check('行走受控：纯景不行走 + 不连续 + 比例≤40% + 不全走', () => {
  const b = composeDeterministicBeats(makeAnalysis(29), '', 29, CASTS.concat(Array(23).fill('主角独处')), 'j1');
  const beats = b.beats;
  const walks = beats.filter((x) => x.isWalk);
  // 1) 比例受控
  assert.ok(walks.length <= Math.ceil(beats.length * 0.4), `行走比例过高: ${walks.length}/${beats.length}`);
  // 2) 不全片皆走
  assert.ok(walks.length < beats.length, '整片皆走');
  // 3) 纯景不行走
  for (const x of beats) {
    if (String(x.cast).includes('纯景')) assert.ok(!x.isWalk, `纯景镜却行走: shot ${x.shot}`);
  }
  // 4) 不连续
  for (let i = 1; i < beats.length; i++) {
    assert.ok(!(beats[i].isWalk && beats[i - 1].isWalk), `连续两镜都走: ${i - 1},${i}`);
  }
  // 5) 标记行走的镜，动作确实含行走词
  for (const x of walks) assert.ok(WALK_RE.test(x.action + ' ' + x.actionEn), `标记为走却无行走动作: ${x.action}`);
  console.log(`    行走镜=${walks.length}/${beats.length}（约 ${(walks.length / beats.length * 100).toFixed(0)}%）`);
});
check('地点明显不同（不同地点数 ≥ 4 / 6）', () => {
  const b = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  const locs = new Set(b.beats.map((x) => x.location));
  assert.ok(locs.size >= 4, `地点多样性不足: ${locs.size}`);
});
check('幕弧包含 Intro 与 Outro（首尾定位）', () => {
  const b = composeDeterministicBeats(makeAnalysis(29), '', 29, CASTS.concat(Array(23).fill('主角独处')), 'j1');
  assert.strictEqual(b.beats[0].act, 'Intro');
  assert.strictEqual(b.beats[28].act, 'Outro');
});
check('纯景段动作为环境动态（非人物）', () => {
  const b = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  const pure = b.beats[0];
  assert.ok(ENV_WORDS.some((w) => pure.action.includes(w)), `纯景动作非环境: ${pure.action}`);
});
check('每镜含因果承接词（narrativeLink）', () => {
  const b = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  for (const x of b.beats) assert.ok(x.narrativeLink && x.narrativeLink.length > 0, `缺承接: shot ${x.shot}`);
});
check('含 logline 且非空', () => {
  const b = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  assert.ok(b.logline && b.logline.length > 4);
});

console.log('B. buildUserPrompt 注入 beat 约束');
check('prompt 含「本镜故事大纲」且允许叙事性行走（非一律禁止）', () => {
  const beats = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  const up = buildUserPrompt(makeAnalysis(6), '', 6, '', null, 'j1', CASTS, beats);
  assert.ok(up.includes('本镜故事大纲'), '缺本镜故事大纲');
  assert.ok(up.includes('不得整片皆走'), '缺行走配额约束');
  assert.ok(!up.includes('禁止改为行走'), '不应再有一律禁止行走的措辞');
});
check('prompt 含全局弧线摘要（logline + 各幕顺序）', () => {
  const beats = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  const up = buildUserPrompt(makeAnalysis(6), '', 6, '', null, 'j1', CASTS, beats);
  assert.ok(up.includes('全片故事弧线'), '缺全局弧线');
  assert.ok(up.includes('故事内核(logline)'), '缺 logline 展示');
});
check('prompt 确实写入了第 1 镜的动作文本', () => {
  const beats = composeDeterministicBeats(makeAnalysis(6), '', 6, CASTS, 'j1');
  const up = buildUserPrompt(makeAnalysis(6), '', 6, '', null, 'j1', CASTS, beats);
  assert.ok(up.includes(beats.beats[0].action), '第1镜动作未注入 prompt');
});
check('未传入 beats 时 prompt 不含弧线段（向后兼容）', () => {
  const up = buildUserPrompt(makeAnalysis(6), '', 6, '', null, 'j1', CASTS, null);
  assert.ok(!up.includes('本镜故事大纲'));
});

console.log('C. buildStoryPlan 无 agnes 时回落确定性编排');
check('返回确定性 beats（行走受控，离线可用）', async () => {
  const p = await buildStoryPlan(makeAnalysis(6), '', 6, CASTS, null, 'j1');
  assert.strictEqual(p.beats.length, 6);
  assert.ok(p.logline);
  const walks = p.beats.filter((x) => x.isWalk);
  assert.ok(walks.length < p.beats.length, '整片皆走');
  assert.ok(walks.length <= Math.ceil(p.beats.length * 0.4), '行走比例过高');
});

console.log(`\n离线单测完成：${pass} 项通过${process.exitCode ? '，存在失败' : '，全部 PASS ✅'}`);
