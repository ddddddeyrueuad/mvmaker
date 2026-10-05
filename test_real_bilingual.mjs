import { resolveAgnes } from './server/src/config.js';
import { generateStoryboard } from './server/src/services/storyboard.js';

const agnes = resolveAgnes({ apiKey: process.env.AGNES_API_KEY, baseUrl: 'https://api.agnes-ai.cn/v1' });
console.log('agnes.enabled =', agnes.enabled);

const analysis = {
  overall: { genre: 'synthwave', mood: 'dreamy', tempoBpm: 110, energy: 0.6, style: 'retro neon cinematic', colorPalette: 'magenta & cyan', suggestedSubject: 'a lone dancer' },
  segments: [
    { index: 0, startTime: 0, mood: 'dreamy', energy: 0.5, motion: 'slow twirl' },
    { index: 1, startTime: 10, mood: 'uplifting', energy: 0.7, motion: 'leap' },
  ],
};

const sb = await generateStoryboard(analysis, null, 2, agnes, 'test-real');
const s0 = sb.segments[0];
console.log('--- keys ---');
console.log('top:', Object.keys(sb));
console.log('seg0:', Object.keys(s0));
console.log('visualBible(ZH):', (sb.visualBible || '').slice(0, 60));
console.log('globalPrompt(EN):', (sb.globalPrompt || '').slice(0, 60));
console.log('globalPromptZh:', (sb.globalPromptZh || '').slice(0, 40));
console.log('seg0.caption(ZH):', (s0.caption || '').slice(0, 50));
console.log('seg0.imagePrompt(EN):', (s0.imagePrompt || '').slice(0, 60));
console.log('seg0.imagePromptZh:', (s0.imagePromptZh || '').slice(0, 40));
console.log('seg0.videoPrompt(EN):', (s0.videoPrompt || '').slice(0, 50));
