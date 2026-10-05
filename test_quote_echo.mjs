/**
 * 1.1.44 分镜自愈新层离线测试（mock agnes，无外网）：
 *   [1] 值内裸引号 JSON → repairUnescapedQuotes 本地修复成功（0 次重生成）
 *   [2] 回声退化（reasoning 复述任务、无 JSON）→ 两轮差异化重生成，第 2 轮成功
 *   [3] 截断字符串 JSON → 本地修复过语法但结构校验未过 → 两轮重生成（截断输出），第 2 轮成功
 *   [4] 两轮重生成参数差异化：variant1=temp0+json_object，variant2=temp0.9+无 json 约束
 *
 * 复现生产日志第 17 镜 6 连败的两类根因：
 *   - Expected ',' or '}' after property value（值内裸引号，本地可修）
 *   - content 空/回声退化 → 同 prompt 同温度重生成陷入死循环（需变换采样打断）
 */
import assert from 'node:assert';
import http from 'node:http';
import { repairAndParseStoryboard } from './server/src/services/storyboard.js';

const PORT = 8931;
const agnes = { enabled: true, baseUrl: `http://127.0.0.1:${PORT}`, apiKey: 't', authType: 'bearer', chatModel: 'agnes-2.5-flash', chatPath: '/chat' };

const requests = [];          // 记录每次重生成请求的 temperature / json 约束
let responder = null;         // 每个用例设置自己的应答策略

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    requests.push({ temperature: parsed.temperature, json: !!(parsed.response_format && parsed.response_format.type === 'json_object') });
    const content = responder(requests.length);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

const IMG = 'cinematic photography, a handsome Chinese man standing alone on an empty old town street at dusk, amber street lamps glowing, long shadows stretching across wet cobblestones, teal and amber color grade, 35mm film grain, shallow depth of field, quiet melancholic atmosphere, photorealistic';
function validSegJson(n) {
  return JSON.stringify({
    segments: [{
      shot: n,
      caption: `第${n}镜：主角独立于黄昏的老城街口，街灯渐次亮起，长影洒在湿润的石板路上`,
      imagePrompt: IMG,
      imagePromptZh: `第${n}镜 黄昏街口`,
      videoPrompt: 'slow dolly forward',
      videoPromptZh: '缓慢向前推镜',
      shotSize: '全景',
      transition: '切',
    }],
  });
}
const normPass = (b) => b;
const mkMessages = (extra) => [{ role: 'system', content: 'sys' + (extra || '') }, { role: 'user', content: '生成第17镜' }];

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

await new Promise((r) => mock.listen(PORT, r));

// [1] 值内裸引号：caption 对白引号未转义 → 本地修复成功，不得触发任何重生成
await check('[1] 值内裸引号 JSON 本地修复成功（0 次重生成）', async () => {
  requests.length = 0;
  const seg = {
    shot: 17,
    caption: '第17镜：她在街口轻声说"别走"，声音淹没在晚风里', // " 别走 " 未转义
    imagePrompt: IMG, imagePromptZh: '第17镜', videoPrompt: 'pan', videoPromptZh: '摇镜',
    shotSize: '全景', transition: '切',
  };
  const broken = JSON.stringify({ segments: [seg] }).replace('说\\"别走\\"', '说"别走"'); // 制造裸引号
  assert.ok(broken.includes('说"别走"'), '测试数据需含裸引号');
  let threw = false;
  try { JSON.parse(broken); } catch { threw = true; }
  assert.ok(threw, '测试数据本身应是坏 JSON');
  const out = await repairAndParseStoryboard(broken, agnes, null, '第 17 镜', 1, mkMessages);
  assert.strictEqual(requests.length, 0, `不应触发重生成，实际 ${requests.length} 次`);
  assert.strictEqual(out.segments[0].caption, seg.caption);
});

// [2] 回声退化：content 只是复述任务（无 JSON）→ 两轮重生成，variant1 空退化、variant2 成功
await check('[2] 回声退化 → 两轮差异化重生成（第 2 轮成功）', async () => {
  requests.length = 0;
  responder = (n) => (n === 1 ? '' : validSegJson(17)); // variant1 仍空退化，variant2 返回合法 JSON
  const out = await repairAndParseStoryboard('用户要求生成第17镜的分镜脚本，我需要先分析音频情绪…', agnes, null, '第 17 镜', 1, mkMessages);
  assert.strictEqual(requests.length, 2, `应恰好两轮重生成，实际 ${requests.length}`);
  assert.strictEqual(out.segments.length, 1);
});

// [3] 截断字符串 JSON：本地补全语法但结构校验未过（caption 过短 / imagePrompt 缺失）→ 两轮重生成，第 2 轮成功
await check('[3] 截断 JSON → 本地修复+两轮重生成（第 2 轮成功）', async () => {
  requests.length = 0;
  const full = validSegJson(17);
  // 截在 caption「独立」处 → 本地补全后 caption 仅 6 字 <10 → normalize 抛错 → 转重生成
  const truncated = full.slice(0, full.indexOf('独立'));
  // variant1 的重生成输出也截断（截在「街口」→ caption 达标但 imagePrompt 缺失 → 仍不过校验）；variant2 返回完整合法 JSON
  responder = (n) => (n === 1 ? full.slice(0, full.indexOf('街口')) : full);
  const out = await repairAndParseStoryboard(truncated, agnes, null, '第 17 镜', 1, mkMessages);
  assert.strictEqual(requests.length, 2, `应恰好两轮重生成，实际 ${requests.length}`);
  assert.strictEqual(out.segments.length, 1);
});

// [4] 两轮重生成参数差异化：variant1=temp0+json_object；variant2=temp0.9+无 json 约束
// （每用例开头清空 requests，此处校验测试 [3] 产生的最后 2 条重生成请求）
await check('[4] 重生成两轮参数差异化（温度/json 约束）', async () => {
  assert.strictEqual(requests.length, 2, `测试 [3] 应产生 2 次重生成请求，实际 ${requests.length}`);
  const r = requests;
  assert.deepStrictEqual(r.map((x) => x.temperature), [0, 0.9], '温度应 0→0.9');
  assert.deepStrictEqual(r.map((x) => x.json), [true, false], 'json 约束应 true→false');
});

mock.close();
console.log(`\n===== test_quote_echo 结果: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail === 0 ? 0 : 1);
