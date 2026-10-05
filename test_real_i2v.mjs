import fs from 'node:fs';

const KEY = process.env.AGNES_API_KEY;
const BASE = 'https://api.agnes-ai.cn/v1';
const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const imgUrl = 'https://platform-outputs.agnes-ai.space/images/t2i/f0b0b5e840a84afcbe0683181d21a964.png';
const imgResp = await fetch(imgUrl);
const buf = Buffer.from(await imgResp.arrayBuffer());
const dataUri = `data:image/png;base64,${buf.toString('base64')}`;
console.log('image bytes=', buf.length, 'dataUri len=', dataUri.length);

console.log('-> I2V submit (model agnes-video-v2.0)');
let submit;
try {
  submit = await fetch(BASE + '/videos', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'agnes-video-v2.0',
      prompt: 'slow cinematic camera movement, serene sunset atmosphere',
      height: 720, width: 1280,
      num_frames: 241, frame_rate: 24,
      tags: ['i2v'],
      image: [dataUri],
      extra_body: { image: [dataUri] },
    }),
  });
} catch (e) { console.log('SUBMIT FETCH ERROR', e.message); process.exit(1); }
const sd = await submit.json();
console.log('  submit status', submit.status);
console.log('  submit body', JSON.stringify(sd).slice(0, 500));
const id = sd.id || sd.video_id || sd?.data?.id || sd?.data?.video_id;
if (!id) { console.log('NO TASK ID - stopping'); process.exit(0); }
console.log('  task id =', id);

const pollUrl = `${BASE.replace(/\/v1$/, '')}/agnesapi?video_id=${encodeURIComponent(id)}`;
console.log('  poll url =', pollUrl);
let last = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const pr = await fetch(pollUrl, { headers: auth });
  last = await pr.json();
  const st = String(last?.status || last?.state || '').toLowerCase();
  console.log(`  poll#${i} status=${last?.status} state=${last?.state}`);
  if (['succeeded','completed','done','success','ready'].includes(st) || last?.url || last?.video_url) break;
  if (['failed','error','cancelled'].includes(st)) { console.log('FAILED', JSON.stringify(last).slice(0,300)); process.exit(0); }
}
const vurl = last?.url || last?.video_url || last?.result?.url || last?.data?.url || last?.output?.url;
console.log('  final video url =', vurl);
if (vurl) {
  const vr = await fetch(vurl);
  const vb = Buffer.from(await vr.arrayBuffer());
  fs.writeFileSync('real_i2v_test.mp4', vb);
  console.log('  saved real_i2v_test.mp4 bytes=', vb.length);
}
