const BASE = 'http://localhost:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postForm(url, fd) {
  return fetch(BASE + url, { method: 'POST', body: fd }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.status);
    return d;
  });
}
function postJson(url, body) {
  return fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.status);
    return d;
  });
}

const fs = await import('node:fs');
const audioBuf = fs.readFileSync('test_audio.wav');

const fd = new FormData();
fd.append('audio', new Blob([audioBuf], { type: 'audio/wav' }), 'test_audio.wav');
fd.append('orientation', 'portrait'); // 竖屏 3:4
const up = await postForm('/api/upload', fd);
console.log('upload:', { jobId: up.jobId?.slice(0, 8), duration: up.duration, segs: up.segments.length, orientation: up.orientation });

const sb = await postJson('/api/storyboard', { jobId: up.jobId, lyrics: '夜空繁星\n我心飞翔' });
const s0 = sb.storyboard.segments[0];
console.log('storyboard bilingual seg0:', {
  shot: s0.shot, timeRange: s0.timeRange,
  caption: (s0.caption || '').slice(0, 30),
  imagePromptEn: (s0.imagePrompt || '').slice(0, 40),
  imagePromptZh: (s0.imagePromptZh || '').slice(0, 30),
  hasVideoZh: !!s0.videoPromptZh,
});
console.log('visualBible:', (sb.storyboard.visualBible || '').slice(0, 40));

const n = up.segments.length;
for (let i = 0; i < n; i++) {
  await postJson('/api/images/generate-one', {
    jobId: up.jobId, index: i,
    imagePrompt: sb.storyboard.segments[i].imagePrompt,
    globalPrompt: sb.storyboard.globalPrompt,
  });
}
console.log('images generated:', n);

for (let i = 0; i < n; i++) {
  await postJson('/api/videos/generate-one', {
    jobId: up.jobId, index: i,
    videoPrompt: sb.storyboard.segments[i].videoPrompt,
    globalVideoPrompt: sb.storyboard.globalVideoPrompt,
  });
}
console.log('videos generated:', n);

const cmp = await postJson('/api/compose', { jobId: up.jobId });
console.log('compose done:', cmp.url);

// ffprobe 验证最终分辨率与时长
const { execSync } = await import('node:child_process');
const info = execSync(`ffprobe -v error -show_entries format=duration:stream=width,height,codec_type -of default=noprint_wrappers=1 ${cmp.path}`).toString();
console.log('--- final MV ffprobe ---');
console.log(info);
