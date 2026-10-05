import http from 'node:http';
import { planStoryArcWithLLM } from './server/src/services/storyboard.js';

function makeDraft(n) {
  return {
    logline: '原始 logline',
    beats: Array.from({ length: n }, (_, i) => ({
      shot: i + 1,
      act: 'Verse',
      emotion: 'happy',
      location: 'loc' + i,
      action: 'stand',
      actionEn: 'stand',
      narrativeLink: '因此',
      motifState: '初绽',
      cast: i % 3 === 0 ? '纯景' : '主角',
      isWalk: false,
      noCharacter: i % 3 === 0,
    })),
  };
}

function startMock(returnEmpty) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let n = 10;
        try {
          const m = JSON.parse(body).messages.find((x) => /必须恰好输出/.test(x.content || ''));
          if (m) { const mm = m.content.match(/必须恰好输出 (\d+) 个 beats/); if (mm) n = parseInt(mm[1], 10); }
        } catch {}
        res.setHeader('Content-Type', 'application/json');
        if (returnEmpty) {
          // 模拟 agnes 偶发 content 空（回声退化）
          res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '用户要求生成故事大纲……（回声退化）' } }] }));
          return;
        }
        const beats = Array.from({ length: n }, (_, i) => ({
          shot: i + 1,
          act: 'Chorus',
          emotion: 'tense',
          location: 'place' + i,
          action: '转身离去',
          narrativeLink: '然而',
          motifState: '盛放',
        }));
        const resp = { logline: 'LLM 优化后的故事内核', beats };
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(resp) } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.error('  FAIL', msg); } }

// ---- 成功路径：29 段 -> 3 分块(10/10/9) 合并 ----
const srv = await startMock(false);
const port = srv.address().port;
const agnes = { enabled: true, baseUrl: `http://127.0.0.1:${port}`, chatPath: '/v1/chat/completions', apiKey: 'test', chatModel: 'mock' };
const analysis = {
  overall: { genre: 'Test', mood: 'happy', moodZh: '快乐', tempoBpm: 120, energy: 0.5, loudness: -15 },
  segments: Array.from({ length: 29 }, (_, i) => ({ index: i, mood: 'happy', moodZh: '快乐', energy: 0.5 })),
};
try {
  const r = await planStoryArcWithLLM(analysis, '测试歌词', 29, makeDraft(29), agnes, null);
  assert(r.beats.length === 29, `合并后 beats 数 = 29（实际 ${r.beats.length}）`);
  assert(r.logline === 'LLM 优化后的故事内核', `logline 来自 LLM 首块（${r.logline}）`);
  const shots = r.beats.map((b) => b.shot);
  assert(JSON.stringify(shots) === JSON.stringify(Array.from({ length: 29 }, (_, i) => i + 1)), 'shot 为绝对序号 1..29 连续');
  // 纯景段（cast 含纯景）不应被 LLM 改成行走
  const pure = r.beats.filter((b) => String(b.cast || '').startsWith('纯景'));
  assert(pure.every((b) => b.isWalk === false), `纯景段保持非行走（${pure.length} 个）`);
  // 非纯景段 LLM 写入了「转身离去」动作
  const nonPure = r.beats.filter((b) => !String(b.cast || '').startsWith('纯景'));
  assert(nonPure.every((b) => b.action === '转身离去'), '非纯景段采用 LLM 动作「转身离去」');
  console.log('  -> 分块大纲合并成功');
} catch (e) {
  fail++; console.error('  FAIL 成功路径抛错:', e.message);
}
srv.close();

// ---- 失败路径：agnes 全空 -> 应抛错（由 buildStoryPlan 回落确定性）----
const srv2 = await startMock(true);
const port2 = srv2.address().port;
const agnes2 = { enabled: true, baseUrl: `http://127.0.0.1:${port2}`, chatPath: '/v1/chat/completions', apiKey: 'test', chatModel: 'mock' };
try {
  await planStoryArcWithLLM(analysis, '测试歌词', 29, makeDraft(29), agnes2, null);
  fail++; console.error('  FAIL 失败路径未抛错（应抛）');
} catch (e) {
  assert(/规划|story JSON|beats/.test(e.message), `失败路径正确抛错（${e.message.slice(0, 40)}）`);
}
srv2.close();

console.log(`\n===== test_story_chunk: ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
