/**
 * 离线端到端自愈验证（直接读源码，非打包）。
 *
 * 完全离线：同时 mock Agnes（注入坏响应）+ mock MERT（返回固定分段分析），
 * 不依赖外部 8791 MERT 服务，CI / 本地一键复跑。
 *
 * 流程：mock Agnes + mock MERT + 真实 Express dev server（node server/src/index.js）
 *   → 上传 50s 短音频 → 走 mock MERT 分析 → 选画风 → regenerate
 *   → 断言 5/5 段全部恢复，并捕获自愈日志。
 *
 * 针对性注入（复现生产级失败）：
 *   - 第 2 镜：截断 JSON（字段完整）  → 触发 tryTruncateRepair 本地自愈（无额外网络调用）
 *   - 第 3 镜：纯散文无 JSON          → 触发「格式强约束重生成」自愈
 *   - 第 5 镜：截断后缺 segments 字段 → 触发「修好语法但结构校验未过→格式强约束重生成」（seg 8 类）
 *   - 第 1、4 镜：正常 JSON
 *
 * 可选：设 USE_REAL_MERT=1 则跳过 mock MERT，让 dev server 自动探测真实 8791 MERT。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NODE = process.execPath;                 // 运行本脚本的 node（managed 22.22.2）
const ROOT = 'D:/TEST/workbuddy mvmaker';
const WAV = process.env.SELFTEST_WAV || 'D:/TEST/selftest_50s.wav';
const MOCK_PORT = 8799;                          // mock Agnes
const MERT_MOCK_PORT = 8801;                     // mock MERT
const SRV_PORT = 3099;
const BASE = `http://127.0.0.1:${SRV_PORT}`;
const USE_REAL_MERT = process.env.USE_REAL_MERT === '1';

// ── 生成测试音频（优先 ffmpeg；缺失则 Node 内联生成静音 WAV） ──
function ensureWav() {
  if (fs.existsSync(WAV)) return;
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=50', '-ac', '2', '-ar', '48000', WAV], { stdio: 'ignore' });
    console.log(`[INFO] ffmpeg 生成测试音频 ${WAV}`);
  } catch {
    // Node 内联生成 50s 静音 PCM16 WAV（约 4.8MB），不依赖外部二进制
    const sr = 48000, dur = 50, ch = 2;
    const dataBytes = sr * dur * ch * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * ch * 2, 28);
    buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
    fs.writeFileSync(WAV, buf);
    console.log(`[INFO] Node 内联生成静音测试音频 ${WAV}`);
  }
}

// ── mock Agnes（注入坏响应） ───────────────────────────────
const mockCalls = [];
function validBoard(n, withGlobals) {
  const seg = {
    caption: `第${n}镜 测试场景：主角站在都市街道上，霓虹灯映照在湿漉漉的地面上`,
    imagePrompt: `cinematic photography, a beautiful Chinese woman standing on a rain-soaked city street at night, neon lights reflecting in puddles, blue and amber tones, shot ${n}, dramatic lighting, photorealistic, 35mm film grain, shallow depth of field, wet ground with colorful reflections, moody atmosphere`,
    imagePromptZh: `第${n}镜 测试场景，电影感`,
    videoPrompt: 'slow dolly forward',
    videoPromptZh: '缓慢向前推镜',
    shotSize: 'medium shot',
    transition: 'cut',
  };
  const board = { segments: [seg] };
  if (withGlobals) {
    board.visualBible = '统一视觉圣经：冷暖对比的都市夜色。';
    board.globalPrompt = 'cinematic urban night, teal and gold grade, anamorphic';
    board.globalPromptZh = '电影感都市夜色，青金调色';
    board.globalVideoPrompt = 'slow cinematic camera move, filmic';
    board.globalVideoPromptZh = '缓慢电影感运镜，胶片质感';
  }
  return board;
}
function validStr(n, withGlobals) { return JSON.stringify(validBoard(n, withGlobals)); }
const REGEN_MARK = '【强制格式】';
const SEG_RE = /你只需生成第\s*(\d+)\s*到第/;

const mock = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const messages = parsed.messages || [];
    const sysContent = String(messages[0]?.content || '');
    const userContent = String(messages[messages.length - 1]?.content || '');
    const isRegen = sysContent.includes(REGEN_MARK);
    const m = userContent.match(SEG_RE);
    const seg = m ? Number(m[1]) : null;
    console.log(`[MOCK -->] url=${req.url} isRegen=${isRegen} seg=${seg} sysHead="${sysContent.slice(0, 40)}" userHead="${userContent.slice(0, 30)}"`);
    let kind;
    if (isRegen) kind = 'valid';                       // 重生成：必须返回合法 JSON
    else if (seg === 2) kind = 'truncated';            // 第 2 镜：截断 JSON（字段完整，本地自愈）
    else if (seg === 3) kind = 'prose';                // 第 3 镜：纯散文无 JSON（触发重生成）
    else if (seg === 5) kind = 'incomplete';           // 第 5 镜：截断后缺 segments（seg 8 类：修好语法但结构校验未过→重生成）
    else kind = 'valid';
    let content;
    if (kind === 'truncated') {
      const v = validStr(seg, seg === 1);
      content = v.slice(0, -3);             // 以 `"transition":"cut` 结尾，缺闭合引号与括号
    } else if (kind === 'prose') {
      content = `用户要求生成第${seg}镜。本镜为纯音乐间奏，画面描绘无人的街角，主角不出现。以下以文字说明而非 JSON 输出：镜头从湿漉漉的地面缓缓上摇至霓虹灯牌，雨水在霓虹倒影里碎成光斑。`;
    } else if (kind === 'incomplete') {
      // 合法 JSON 对象但不含 segments 字段，且末尾字符串未闭合 → 本地修复后结构校验未过，应转重生成
      content = `{"caption":"本镜描绘无人的街角","note":"被截断`;
    } else {
      content = validStr(seg ?? 1, seg === 1 || isRegen);
    }
    mockCalls.push({ seg, isRegen, kind });
    console.log(`[MOCK] seg=${seg} regen=${isRegen} -> ${kind}`);
    const resp = { choices: [{ message: { content } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(resp));
  });
});

// ── mock MERT（返回固定 4 段分析，schema 与 mert_infer.py 一致） ──
function mockMertAnalysis() {
  const overall = {
    genre: 'Ambient', mood: 'melancholic', moodZh: '忧郁', tempoBpm: 92,
    energy: 0.45, loudness: -18.2, warmth: 0.52,
    style: 'cinematic 3d render, anamorphic lens, soft volumetric light',
    colorPalette: 'teal & gold',
    suggestedSubject: 'a handsome Chinese man, contemplative bearing',
    mertMean: 0.5, mertStd: 0.15,
  };
  const segments = [0, 10, 20, 30, 40].map((start, i) => ({
    index: i, startTime: start,
    energy: +(0.3 + (i % 3) * 0.12).toFixed(3),
    brightness: +(0.4 + (i % 4) * 0.08).toFixed(3),
    loudness: +(-22 + (i % 3) * 3).toFixed(1),
    tempoBpm: 90 + ((i * 3) % 11),
    mood: ['melancholic', 'warm', 'mysterious', 'dreamy', 'contemplative'][i],
    moodZh: ['忧郁', '温暖', '神秘', '梦幻', '沉思'][i],
    motion: ['slow pan', 'gentle drift', 'dolly forward', 'orbit', 'rise'][i],
    energyDelta: { dB: 0, trend: 'flat' },
  }));
  return { overall, segments };
}
let mockMert;
function startMockMert() {
  if (USE_REAL_MERT) { console.log('[INFO] USE_REAL_MERT=1，跳过 mock MERT，连接真实 8791'); return Promise.resolve(); }
  mockMert = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    // POST /mert：multipart 上传音频，忽略 body，直接返回固定分析
    req.on('data', () => {});
    req.on('end', () => {
      const resp = mockMertAnalysis();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resp));
      console.log(`[MOCK MERT] 返回 ${resp.segments.length} 段分析`);
    });
  });
  return new Promise((r) => mockMert.listen(MERT_MOCK_PORT, r)).then(() =>
    console.log(`[MOCK MERT] 监听 :${MERT_MOCK_PORT}/mert`));
}

// ── 启动 dev server（直接读源码） ──────────────────────────
const serverLogs = [];
let srvProc;
function startServer() {
  const env = {
    ...process.env,
    AGNES_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    AGNES_API_KEY: 'test-selfheal',
    AGNES_CHAT_MODEL: 'agnes-2.5-flash',
    PORT: String(SRV_PORT),
  };
  if (!USE_REAL_MERT) {
    // 指向 mock MERT（config 会 strip 尾斜杠，这里不带尾斜杠）
    env.MERT_REMOTE_URL = `http://127.0.0.1:${MERT_MOCK_PORT}/mert`;
  } else {
    delete env.MERT_REMOTE_URL;   // 让 dev server 自动探测 8791 真实 MERT
  }
  delete env.MERT_LOCAL;
  srvProc = spawn(NODE, ['server/src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srvProc.stdout.on('data', (d) => { const s = d.toString(); serverLogs.push(s); process.stdout.write('[SRV] ' + s); });
  srvProc.stderr.on('data', (d) => { const s = d.toString(); serverLogs.push(s); process.stdout.write('[SRV!] ' + s); });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dev server 启动超时')), 30000);
    const probe = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { clearTimeout(t); clearInterval(probe); resolve(); }
      } catch { /* not up yet */ }
    }, 500);
  });
}

async function main() {
  ensureWav();
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  console.log(`[MOCK] agnes mock 监听 :${MOCK_PORT}`);
  await startMockMert();
  await startServer();
  console.log('[INFO] dev server 已启动，开始端到端验证');

  // 1) 上传音频
  const form = new FormData();
  form.append('audio', new Blob([fs.readFileSync(WAV)], { type: 'audio/wav' }), 'selftest_40s.wav');
  const up = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  const upJson = await up.json();
  const jobId = upJson.jobId;
  const segCount = upJson.segments?.length ?? 5;
  console.log(`[INFO] 上传完成 job=${jobId} segments=${segCount}`);

  // 2) MERT 音频分析（mock 或真实 8791）
  console.log(`[INFO] 调用 /api/storyboard 进行 MERT 分析（${USE_REAL_MERT ? '真实8791' : 'mock'}）…`);
  const an = await fetch(`${BASE}/api/storyboard`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId }), timeout: 480000,
  });
  const anJson = await an.json();
  if (!anJson.analysis) throw new Error('MERT 分析失败：' + JSON.stringify(anJson).slice(0, 300));
  console.log(`[INFO] MERT 分析完成 流派=${anJson.analysis.overall?.genre} BPM=${anJson.analysis.overall?.tempoBpm} 段数=${anJson.analysis.segments?.length}`);

  // 3) 选画风
  const styles = await (await fetch(`${BASE}/api/job/${jobId}/styles`)).json();
  const styleId = styles.catalog?.[0]?.id || 'cinematic';
  console.log(`[INFO] 选用画风 styleIds=[${styleId}] (catalog 共 ${styles.catalog?.length || 0})`);

  // 4) regenerate（触发 Agnes 分镜生成 + 自愈）
  console.log('[INFO] 调用 /api/storyboard/regenerate（逐段生成，注入坏响应）…');
  const reg = await fetch(`${BASE}/api/storyboard/regenerate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId, styleIds: [styleId] }), timeout: 300000,
  });
  const regJson = await reg.json();
  if (regJson.error) throw new Error('regenerate 失败：' + regJson.error);

  // 5) 校验
  const job = await (await fetch(`${BASE}/api/job/${jobId}`)).json();
  const board = job.storyboard;
  const nSeg = board?.segments?.length || 0;
  const missing = board?.missingSegments || [];
  console.log(`\n===== 验证结果 =====`);
  console.log(`分镜段数: ${nSeg}/${segCount}  missingSegments=${JSON.stringify(missing)}`);
  console.log(`mock Agnes 调用明细:`);
  for (const c of mockCalls) console.log(`  seg=${c.seg} regen=${c.isRegen} kind=${c.kind}`);

  const proseCall = mockCalls.find((c) => c.kind === 'prose' && !c.isRegen);
  const regenForProse = mockCalls.find((c) => c.seg === proseCall?.seg && c.isRegen);
  const truncatedCall = mockCalls.find((c) => c.kind === 'truncated');
  const incompleteCall = mockCalls.find((c) => c.kind === 'incomplete' && !c.isRegen);
  const regenForIncomplete = mockCalls.find((c) => c.seg === incompleteCall?.seg && c.isRegen);
  const selfHealLocal = serverLogs.some((l) => l.includes('本地自愈修复成功'));
  const selfHealRegen = serverLogs.some((l) => l.includes('触发格式强约束重生成'));
  const selfHealRegenAfterRepair = serverLogs.some((l) => l.includes('本地自愈修复后结构校验未通过'));

  // 故事大纲（beat sheet）随响应返回，且每镜动作无"走路"
  const sp = board?.storyPlan;
  const spBeats = sp?.beats || [];
  const spIsPure = (b) => String(b.cast || '').includes('纯景');
  const spWalkCount = spBeats.filter((b) => b.isWalk).length;
  const spWalkOK = spBeats.length > 0 &&
    spWalkCount < spBeats.length &&                                                   // 不全片皆走
    spWalkCount <= Math.ceil(spBeats.length * 0.4) &&                               // 行走比例≤40%
    spBeats.every((b) => !spIsPure(b) || !b.isWalk) &&                             // 纯景不行走
    spBeats.every((b, i) => !(b.isWalk && spBeats[i - 1] && spBeats[i - 1].isWalk)); // 不连续
  const spArcs = spBeats.map((b) => b.act).join(' → ');

  console.log(`\n断言:`);
  console.log(`  [1] 全部段恢复 N=${nSeg}/${segCount} 且无缺失: ${nSeg === segCount && missing.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  [2] 第2镜截断JSON被注入且本地自愈: ${truncatedCall ? 'INJECTED' : 'NO'}`);
  console.log(`  [3] 本地自愈日志出现: ${selfHealLocal ? 'PASS' : 'FAIL'}`);
  console.log(`  [4] 第3镜散文被注入且触发重生成: ${proseCall && regenForProse ? 'PASS' : 'NO'}`);
  console.log(`  [5] 重生成自愈日志出现: ${selfHealRegen ? 'PASS' : 'FAIL'}`);
  console.log(`  [6] 第5镜「修好语法但结构校验未过」被注入且触发重生成: ${incompleteCall && regenForIncomplete ? 'PASS' : 'NO'}`);
  console.log(`  [7] 修复后转重生成的日志出现（seg 8 类兜底）: ${selfHealRegenAfterRepair ? 'PASS' : 'FAIL'}`);
  console.log(`  [8] 故事大纲随响应返回且 beats 数=${spBeats.length}/${segCount}: ${spBeats.length === segCount ? 'PASS' : 'FAIL'}`);
  console.log(`  [9] 大纲行走受控(允许叙事性行走,非纯景/不连续/比例≤40%/不全走): ${spWalkOK ? 'PASS' : 'FAIL'}`);
  console.log(`      弧线: ${spArcs}`);

  const ok = nSeg === segCount && missing.length === 0 && truncatedCall && selfHealLocal &&
    proseCall && regenForProse && incompleteCall && regenForIncomplete && selfHealRegen && selfHealRegenAfterRepair &&
    spBeats.length === segCount && spWalkOK;
  console.log(`\n>>>> 总体: ${ok ? 'PASS 自愈+故事大纲生效，可打包' : 'FAIL 需排查'}`);
  return ok;
}

main()
  .then((ok) => {
    try { srvProc?.kill(); mock.close(); mockMert?.close(); } catch {}
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error('[FATAL]', e);
    try { srvProc?.kill(); mock.close(); mockMert?.close(); } catch {}
    process.exit(2);
  });
