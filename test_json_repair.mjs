/**
 * 离线逻辑单测：JSON 自愈的本地修复层 tryTruncateRepair + parseJSON。
 * 无网络、无 MERT 依赖，作为 CI / 日常快速回归（npm run verify:json）。
 *
 * 覆盖：正常 JSON / 截断（缺闭合引号与括号）/ ```json 围栏截断 / 散文无 JSON /
 *       内部含转义引号与反斜杠的截断 / 散文夹杂完整 JSON（取首个对象）。
 */
import assert from 'node:assert';
import { tryTruncateRepair } from './server/src/services/storyboard.js';
import { parseJSON } from './server/src/services/llm.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// A. 正常 JSON 原样返回等价对象
check('A 正常 JSON 被原样修复（等价对象）', () => {
  const obj = { segments: [{ caption: 'x', transition: 'cut' }] };
  const fixed = tryTruncateRepair(JSON.stringify(obj));
  assert.deepStrictEqual(fixed, obj);
});

// B. 截断 JSON（缺闭合引号与括号）→ 本地补全
check('B 截断 JSON（缺闭合引号与括号）被本地补全', () => {
  const full = JSON.stringify({ segments: [{ caption: '第2镜 测试', transition: 'cut' }] });
  const truncated = full.slice(0, -3); // 以 `"transition":"cut` 结尾
  const fixed = tryTruncateRepair(truncated);
  assert.ok(fixed && Array.isArray(fixed.segments) && fixed.segments.length === 1);
  assert.strictEqual(fixed.segments[0].caption, '第2镜 测试');
  assert.strictEqual(fixed.segments[0].transition, 'cut');
});

// C. ```json 围栏包裹的完整 JSON 应能被提取（顶层闭合后丢弃尾随围栏）
check('C ```json 围栏包裹的完整 JSON 被提取', () => {
  const inner = JSON.stringify({ caption: 'fenced', transition: 'cut' });
  const text = '```json\n' + inner + '\n```';
  const fixed = tryTruncateRepair(text);
  assert.ok(fixed && fixed.caption === 'fenced' && fixed.transition === 'cut');
});

// D. 纯散文无 JSON → 返回 null（上层触发重生成）
check('D 散文无 { 返回 null（交给重生成）', () => {
  const fixed = tryTruncateRepair('用户要求生成第3镜。本镜为纯音乐间奏，画面描绘无人的街角，主角不出现。');
  assert.strictEqual(fixed, null);
});

// E. 字符串内含引号/反斜杠（完整转义）的对象被完好修复
check('E 含转义引号/反斜杠的完整对象被完好修复', () => {
  const full = JSON.stringify({ caption: '他说："你好"', note: 'a\\b' });
  const truncated = full.slice(0, -1); // 去掉末 }，保留完整转义字段
  const fixed = tryTruncateRepair(truncated);
  assert.ok(fixed && fixed.caption === '他说："你好"' && fixed.note === 'a\\b');
});

// F. 散文夹杂完整 JSON（取首个 { 起的对象）
check('F 散文 + 完整 JSON 取首个对象', () => {
  const obj = { segments: [{ caption: 'mix' }] };
  const text = '以下是分镜脚本：' + JSON.stringify(obj) + ' 结束。';
  const fixed = tryTruncateRepair(text);
  assert.deepStrictEqual(fixed, obj);
});

// G. parseJSON 能从散文+JSON 中抽取（与 tryTruncateRepair 互补的容忍抽取层）
check('G parseJSON 从散文中抽取完整 JSON', () => {
  const obj = { segments: [{ caption: 'extract' }] };
  const text = '解释一下：' + JSON.stringify(obj);
  const parsed = parseJSON(text);
  assert.deepStrictEqual(parsed, obj);
});

console.log(`\n===== verify:json 结果: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail === 0 ? 0 : 1);
