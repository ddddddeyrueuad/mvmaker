import fs from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://localhost:3001';
const AUDIO = 'D:/TEST/workbuddy mvmaker/test_audio.wav';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffprobeDur(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', file]);
    let out=''; p.stdout.on('data',d=>out+=d); p.on('close',c=>resolve(parseFloat(out.trim())));
  });
}

const buf = fs.readFileSync(AUDIO);
const form = new FormData();
form.append('audio', new Blob([buf], { type: 'audio/wav' }), 'test_audio.wav');

console.log('→ 步骤1 上传音频…');
const up = await (await fetch(BASE + '/api/upload', { method: 'POST', body: form })).json();
console.log('  jobId=', up.jobId, '时长=', up.duration, '切片=', up.segments.length);

console.log('→ 步骤2 mert+agnes 分镜…');
const sb = await (await fetch(BASE + '/api/storyboard', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jobId: up.jobId, lyrics: '夜空的星光\n流浪的旅人\n回到故乡' }),
})).json();
console.log('  globalPrompt=', sb.storyboard.globalPrompt.slice(0, 40), '...');
console.log('  分镜段数=', sb.storyboard.segments.length, '(应=', up.segments.length, ')');

console.log('→ 步骤3 文生图…');
for (let i = 0; i < sb.storyboard.segments.length; i++) {
  const r = await (await fetch(BASE + '/api/images/generate-one', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: up.jobId, index: i, imagePrompt: sb.storyboard.segments[i].imagePrompt, globalPrompt: sb.storyboard.globalPrompt }),
  })).json();
  console.log(`  图${i + 1} OK`, r.url);
}

console.log('→ 步骤4 图生视频…');
for (let i = 0; i < sb.storyboard.segments.length; i++) {
  const r = await (await fetch(BASE + '/api/videos/generate-one', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: up.jobId, index: i, videoPrompt: sb.storyboard.segments[i].videoPrompt, globalVideoPrompt: sb.storyboard.globalVideoPrompt }),
  })).json();
  console.log(`  视频${i + 1} OK`, r.url);
}

console.log('→ 步骤5 合成 MV…');
const mv = await (await fetch(BASE + '/api/compose', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jobId: up.jobId }),
})).json();
console.log('  MV=', mv.url);

const finalPath = 'D:/TEST/workbuddy mvmaker/server/uploads/' + up.jobId + '/mv_final.mp4';
const dur = await ffprobeDur(finalPath);
console.log('  最终 MV 时长=', dur.toFixed(2), 's (音频=', up.duration, 's)');
console.log(dur >= up.duration - 0.5 ? '✅ 音视频对齐校验通过' : '⚠️ 时长偏差较大');
