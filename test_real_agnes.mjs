const KEY = process.env.AGNES_API_KEY;
const BASE = 'https://api.agnes-ai.cn/v1';
const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

console.log('→ CHAT test (model agnes-2.5-flash)');
try {
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'agnes-2.5-flash',
      stream: false,
      messages: [
        { role: 'system', content: '你只输出JSON。' },
        { role: 'user', content: '用一句话描述"夕阳下的城市"作为视频分镜，只返回 {"caption":"..."}' },
      ],
    }),
  });
  console.log('  status', r.status);
  const j = await r.json();
  console.log('  ', JSON.stringify(j).slice(0, 400));
} catch (e) { console.log('  CHAT ERROR', e.message); }

console.log('→ T2I test (model agnes-image-2.1-flash)');
try {
  const r = await fetch(BASE + '/images/generations', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'agnes-image-2.1-flash',
      prompt: 'a serene sunset over a cyberpunk city, cinematic',
      n: 1,
      size: '1024x768',
    }),
  });
  console.log('  status', r.status);
  const j = await r.json();
  console.log('  ', JSON.stringify(j).slice(0, 400));
} catch (e) { console.log('  T2I ERROR', e.message); }
