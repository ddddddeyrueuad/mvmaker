import assert from 'node:assert';
import { translateZh, ensureZh } from './server/src/services/storyboard.js';

const agnes = { enabled: true, chatModel: 'agnes-2.5-flash' };
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.error('  FAIL', name, '->', e.message); fail++; }
}

// 合法翻译 JSON（含一个未转义引号，模拟对白："她说"你好"）
function okJson() {
  return JSON.stringify({
    globalPromptZh: '一个在雨夜独行的人',
    globalVideoPromptZh: '电影感运镜',
    segments: [
      { imagePromptZh: '她说"你好"，雨落肩头', videoPromptZh: '镜头缓缓推进' },
      { imagePromptZh: '窗边的侧影', videoPromptZh: '逆光摇移' },
    ],
  });
}

// [1] 成功：直接返回翻译对象（含未转义引号，本地修复应救活）
await check('[1] 成功翻译（含裸引号本地修复）应填充中文', async () => {
  const payload = { globalPrompt: 'x', globalVideoPrompt: 'y', segments: [{ imagePrompt: 'a', videoPrompt: 'b' }, { imagePrompt: 'c', videoPrompt: 'd' }] };
  const out = await translateZh(payload, agnes, null, async () => okJson());
  assert.strictEqual(out.globalPromptZh, '一个在雨夜独行的人');
  assert.strictEqual(out.segments.length, 2);
  assert.strictEqual(out.segments[0].imagePromptZh, '她说"你好"，雨落肩头');
  assert.strictEqual(out.segments[1].videoPromptZh, '逆光摇移');
});

// [2] 轮1回声退化 → 轮2成功，且两轮参数差异化
await check('[2] 轮1回声退化后轮2成功，参数差异化', async () => {
  const calls = [];
  const chatFn = async (a, msgs, opts) => {
    calls.push({ msgs, opts });
    if (calls.length === 1) return '用户要求将英文文生图提示词翻译为简体中文，以下是说明……'; // 回声
    return okJson();
  };
  const out = await translateZh({ segments: [{}, {}] }, agnes, null, chatFn);
  assert.strictEqual(calls.length, 2, `应恰好两轮，实际 ${calls.length}`);
  assert.strictEqual(calls[0].opts.temperature, 0.3, '轮1温度应为 0.3');
  assert.strictEqual(calls[0].opts.json, true, '轮1应带 json 约束');
  assert.strictEqual(calls[1].opts.temperature, 0.7, '轮2温度应为 0.7');
  assert.strictEqual(calls[1].opts.json, false, '轮2应去掉 json 约束');
  assert.ok(/强制格式/.test(calls[1].msgs[1].content), '轮2 user 应含强制格式指令');
  assert.strictEqual(out.segments[0].imagePromptZh, '她说"你好"，雨落肩头');
});

// [3] 两轮都回声退化 → 抛错（由 ensureZh 兜底英文）
await check('[3] 两轮均回声退化应抛错', async () => {
  const chatFn = async () => '用户要求将英文文生图提示词翻译为简体中文……';
  await assert.rejects(
    () => translateZh({ segments: [{}] }, agnes, null, chatFn),
    /中文提示词补全失败|回声退化|JSON/
  );
});

// [4] 轮1返回纯散文（无JSON、未触发echo前缀）也应重试到轮2
await check('[4] 轮1散文非JSON → 轮2成功', async () => {
  const calls = [];
  const chatFn = async (a, msgs, opts) => {
    calls.push(opts);
    if (calls.length === 1) return '这是一段无关的散文，没有JSON结构。';
    return okJson();
  };
  const out = await translateZh({ segments: [{}] }, agnes, null, chatFn);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(out.segments[0].imagePromptZh, '她说"你好"，雨落肩头');
});

// [5] ensureZh 成功路径：中文应真正填充（不再因数 normalize 误抛而回退英文）
await check('[5] ensureZh 成功路径填充中文提示词', async () => {
  const board = {
    globalPrompt: 'A lonely man', globalVideoPrompt: 'cinematic shot',
    segments: [
      { imagePrompt: 'rain on street', videoPrompt: 'push in' },
      { imagePrompt: 'silhouette by window', videoPrompt: 'backlight pan' },
    ],
  };
  const out = await ensureZh(board, agnes, null, async () => okJson());
  assert.strictEqual(out.segments[0].imagePromptZh, '她说"你好"，雨落肩头');
  assert.strictEqual(out.segments[1].videoPromptZh, '逆光摇移');
  assert.strictEqual(out.globalPromptZh, '一个在雨夜独行的人');
});

// [6] ensureZh 全失败：优雅回退英文（不抛错、不 mock）
await check('[6] ensureZh 全失败回退英文且不抛错', async () => {
  const board = {
    globalPrompt: 'A lonely man', globalVideoPrompt: 'cinematic shot',
    segments: [{ imagePrompt: 'rain on street', videoPrompt: 'push in' }],
  };
  const out = await ensureZh(board, agnes, null, async () => '用户要求将英文文生图提示词翻译为简体中文……');
  // 兜底：中文字段 = 英文原值
  assert.strictEqual(out.segments[0].imagePromptZh, 'rain on street');
  assert.strictEqual(out.globalPromptZh, 'A lonely man');
});

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
