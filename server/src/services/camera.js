// 10 种电影化运镜（基于用户提供的「镜头语言库」）。
// 每个运镜：中文名 / 英文名 / 英文运动描述片段（直接用于 videoPrompt）/ 适用情境。
// pickCamera(seg, overall, lyricLine) 依据 MERT 特征（能量 / 相对能量 / 明度 / 情绪）
// 与对应歌词关键词，为每一段挑选最合适的运镜，保证"音乐 + 歌词 → 灵活运镜"。

// 轻量确定性随机源（内联，避免与 storyboard.js 形成循环依赖）
function hashStr(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CAMERA_MOVEMENTS = {
  push: {
    id: 'push', zh: '推镜头', en: 'push-in / dolly in',
    enPrompt: 'slow push-in, gradually approaching the subject and focusing on detail',
    when: '逐渐靠近、聚焦主体、突出细节',
  },
  pull: {
    id: 'pull', zh: '拉镜头', en: 'pull-out / dolly out',
    enPrompt: 'slow pull-out, gradually retreating to reveal the surrounding environment',
    when: '逐渐远离、展示环境、交代整体',
  },
  pan: {
    id: 'pan', zh: '摇镜头', en: 'pan',
    enPrompt: 'steady pan around a fixed pivot, scanning the scene from a new angle',
    when: '围绕固定点转动、展示全景或局部、转换角度',
  },
  move: {
    id: 'move', zh: '移镜头', en: 'tracking / lateral move',
    enPrompt: 'smooth lateral or vertical tracking move, gliding through the space',
    when: '水平或垂直移动、跟随、营造动态感',
  },
  follow: {
    id: 'follow', zh: '跟镜头', en: 'follow shot',
    enPrompt: 'follow shot keeping the moving subject centered in frame',
    when: '跟随运动主体、保持主体在画面中心、展现运动过程',
  },
  rise: {
    id: 'rise', zh: '升镜头', en: 'crane up / rise',
    enPrompt: 'camera rises from low to high, expanding the view upward',
    when: '由低向高拍摄、展示上升过程、扩展视野',
  },
  descend: {
    id: 'descend', zh: '降镜头', en: 'crane down / descend',
    enPrompt: 'camera descends from high to low, emphasizing the scene change',
    when: '由高向低拍摄、表现下降趋势、强调场景变化',
  },
  whip: {
    id: 'whip', zh: '甩镜头', en: 'whip pan / swish',
    enPrompt: 'fast whip pan with motion blur, building tension or a sharp transition',
    when: '快速转动、产生模糊、制造紧张氛围或转场',
  },
  orbit: {
    id: 'orbit', zh: '环绕镜头', en: 'orbit / 360',
    enPrompt: 'orbital camera circling the subject, revealing it from every side',
    when: '围绕主体做圆周运动、全方位展示主体',
  },
  fly: {
    id: 'fly', zh: '穿梭镜头', en: 'fly-through',
    enPrompt: 'rapid fly-through weaving between objects, enhancing rhythm and spatial depth',
    when: '在物体之间快速穿梭、增强节奏感和空间感',
  },
};

// 歌词关键词 → 运镜偏好（命中即优先采用，体现"歌词驱动运镜"）
const LYRIC_HINTS = [
  { keys: ['飞', '穿梭', '风', '奔', '冲', '穿越', '掠', '翔'], cam: 'fly' },
  { keys: ['跟', '随', '走', '行', '追', '奔跑', '追逐', '步'], cam: 'follow' },
  { keys: ['升', '起', '高', '天空', '翱', '上扬', '扬'], cam: 'rise' },
  { keys: ['落', '降', '坠', '下', '沉', '深', '跌', '坠'], cam: 'descend' },
  { keys: ['远', '海', '山', '世界', '全', '阔', '广', '风景', '原野'], cam: 'pull' },
  { keys: ['近', '脸', '眼', '心', '细', '微', '特写'], cam: 'push' },
  { keys: ['转', '环', '绕', '周', '圈', '旋'], cam: 'orbit' },
  { keys: ['摇', '看', '望', '景', '扫', '观'], cam: 'pan' },
  { keys: ['快', '急', '瞬', '闪', '猛', '突', '疾'], cam: 'whip' },
  { keys: ['移', '穿', '过', '街', '巷', '流', '掠过'], cam: 'move' },
];

function lyricCam(line) {
  if (!line) return null;
  for (const h of LYRIC_HINTS) {
    if (h.keys.some((k) => line.includes(k))) return h.cam;
  }
  return null;
}

const ENERGY_HIGH = 1.18; // 相对能量阈值：很响
const ENERGY_MID = 0.9;   // 中等
const ENERGY_LOW = 0.72;  // 较低

/**
 * 为单段挑选运镜。
 * @param {object} seg     逐段分析结果 { energy, brightness, mood, ... }
 * @param {object} overall 全曲分析 { energy, ... }
 * @param {string} lyricLine 该段对应的歌词行（可选）
 * @returns {{id,zh,en,enPrompt,reason}}
 */
export function pickCamera(seg = {}, overall = {}, lyricLine = '', seed = null) {
  const e = seg.energy ?? 0.5;
  const gE = overall.energy ?? 0.5;
  const rel = gE > 0 ? e / gE : 1;
  const b = seg.brightness ?? 0.5;
  const mood = (seg.mood || 'dreamy').toLowerCase();
  const isEnergetic = ['energetic', 'uplifting'].includes(mood);
  const isCalm = ['melancholic', 'dreamy', 'mysterious'].includes(mood);
  // 节奏(tempo)作为重要参考融入运镜候选（与系统提示词 ⑤ 一致：节奏是参考，非机械覆盖）
  const bpm = overall?.tempoBpm;
  const isFast = typeof bpm === 'number' && bpm >= 128;
  const isSlow = typeof bpm === 'number' && bpm < 82;
  // seed 给定 → 同任务同段恒定、跨任务不同的随机源；否则退回 Math.random（兜底场景）
  const rng = seed != null ? makeRng(hashStr(`${seed}`)) : Math.random;
  const pick = (cands) => cands[Math.floor(rng() * cands.length)];

  let ids;
  const lc = lyricCam(lyricLine); // 歌词关键词优先
  if (lc) {
    ids = [lc];
  } else if (rel >= ENERGY_HIGH) {
    if (isEnergetic) ids = b >= 0.6 ? ['fly', 'follow', 'whip'] : ['follow', 'fly', 'move'];
    else if (mood === 'mysterious') ids = ['whip', 'orbit', 'fly'];
    else ids = ['follow', 'move', 'push'];
  } else if (rel >= 1.05) {
    if (isEnergetic) ids = ['follow', 'move', 'push'];
    else if (isCalm) ids = ['push', 'orbit', 'pan'];
    else ids = ['move', 'follow', 'pan'];
  } else if (rel >= ENERGY_MID) {
    if (mood === 'mysterious') ids = ['orbit', 'pan', 'pull'];
    else if (isCalm) ids = ['pan', 'orbit', 'pull'];
    else ids = ['move', 'pan', 'follow'];
  } else if (rel >= ENERGY_LOW) {
    if (b < 0.4) ids = ['descend', 'pull', 'rise'];
    else if (b >= 0.6) ids = ['rise', 'pull', 'pan'];
    else ids = ['pull', 'rise', 'descend'];
  } else {
    if (mood === 'melancholic' || b < 0.4) ids = ['descend', 'pull', 'pan'];
    else if (mood === 'dreamy') ids = ['rise', 'pull', 'pan'];
    else ids = ['pull', 'rise', 'pan'];
  }

  // 节奏参考：快歌偏动态运镜、慢歌偏舒缓运镜（不覆盖歌词关键词，仅扩展候选池以与 ⑤ 对齐）
  if (!lc) {
    if (isFast && !isCalm) ids = Array.from(new Set([...ids, 'fly', 'whip', 'follow']));
    else if (isSlow && !isEnergetic) ids = Array.from(new Set([...ids, 'pull', 'pan', 'rise', 'descend']));
  }

  const id = pick(ids);
  const c = CAMERA_MOVEMENTS[id];
  const reason = `rel=${rel.toFixed(2)}, bright=${b.toFixed(2)}, mood=${mood}${lc ? ', lyric-hint' : ''}${seed != null ? ', rng' : ''}`;
  return { id: c.id, zh: c.zh, en: c.en, enPrompt: c.enPrompt, reason };
}

/** 把歌词按行拆分并均匀分配到每一段（用于逐段歌词提示） */
// ── LRC 解析：把 [mm:ss.xx] / [mm:ss.xxx] 时间戳歌词按真实演唱时刻对齐到各分镜段 ──
const LRC_STAMP_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

// 解析 LRC 文本 → 按时间升序的 { time, text }[]。
// 仅取带时间戳且剥离时间戳后仍有文本的行；[ti:]/[ar:] 等纯元数据行与空行被跳过。
export function parseLRC(lyrics) {
  if (!lyrics) return [];
  const timed = [];
  for (const raw of String(lyrics).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    LRC_STAMP_RE.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = LRC_STAMP_RE.exec(line)) !== null) {
      const mm = parseInt(m[1], 10);
      const ss = parseInt(m[2], 10);
      const fracStr = m[3] || '';
      const frac = fracStr ? (fracStr.length >= 3 ? parseInt(fracStr, 10) / 1000 : parseInt(fracStr, 10) / 100) : 0;
      stamps.push(mm * 60 + ss + frac);
    }
    if (!stamps.length) continue; // 无时间戳的普通歌词行：不参与时间对齐（由调用方决定）
    const text = line.replace(LRC_STAMP_RE, '').trim();
    if (!text) continue; // 纯时间戳 / 元数据行
    for (const t of stamps) timed.push({ time: t, text });
  }
  timed.sort((a, b) => a.time - b.time);
  return timed;
}

// 去掉 LRC 时间戳，返回干净的纯歌词文本（用于注入「歌词优先」叙事块，避免 [00:01.21] 噪声干扰模型）
export function stripLRC(lyrics) {
  if (!lyrics) return '';
  return String(lyrics)
    .split('\n')
    .map((l) => l.replace(LRC_STAMP_RE, '').trim())
    .filter(Boolean)
    .join('\n');
}

// 由 MERT 逐段响度/能量反推「人声/活跃段」位图：用于无 LRC 时间戳时，
// 把纯文本歌词只分配到有人声/有内容的段，间奏/近静音段留白（宜纯景/氛围）。
// 返回长度 = segCount 的布尔数组；数据不足或阈值失稳时回退为全 true（退回均匀比例）。
export function buildVocalMask(segments, segCount) {
  const n = Math.max(0, segCount | 0);
  if (!n) return [];
  const vals = [];
  for (let i = 0; i < n; i++) {
    const s = segments && segments[i];
    const raw = s ? (s.loudness != null ? s.loudness : s.energy != null ? s.energy : null) : null;
    vals.push(raw == null ? null : Number(raw));
  }
  const nums = vals.filter((v) => v != null);
  if (nums.length < 2) return Array(n).fill(true); // 无有效响度 → 全 true
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (max - min < 1e-6) return Array(n).fill(true); // 无变化，无法区分 → 全 true
  // 最安静的约 18% 段判为间奏/留白；活跃度过低时放宽到 8% 以免几乎全空
  let thr = min + 0.18 * (max - min);
  let mask = vals.map((v) => (v == null ? true : v >= thr));
  const active = mask.filter(Boolean).length;
  if (active < Math.max(2, Math.floor(n * 0.5))) {
    thr = min + 0.08 * (max - min);
    mask = vals.map((v) => (v == null ? true : v >= thr));
  }
  return mask;
}

// 歌词 → 逐段对齐（核心：让分镜与真实演唱时刻同步）。
//   - 含 LRC 时间戳：按真实演唱时刻把歌词行归到对应段（段长默认 segDuration=10s，与分镜 N=ceil(dur/10) 一致）；
//     同一 10s 段内多行歌词用 ' / ' 连接；无人声的器乐段返回 ''（提示为纯音乐间奏，宜纯景/氛围）。
//   - 无时间戳 + 提供 vocalMask（音频反推的人声段位图）：仅在活跃段内按歌词顺序分布，间奏段留白。
//   - 无时间戳且无位图 / 解析失败：退回旧的「按行比例分配」以保证兼容。
// 返回长度 = segCount 的数组，元素为该段对齐到的歌词文本（无则 ''）。
export function lyricLinesForSegs(lyrics, segCount, opts = {}) {
  const segDuration = opts.segDuration || 10;
  const timed = parseLRC(lyrics);
  if (timed.length) {
    const out = Array(Math.max(0, segCount)).fill('');
    for (const { time, text } of timed) {
      let idx = Math.floor(time / segDuration);
      if (idx < 0) idx = 0;
      if (idx >= segCount) idx = segCount - 1;
      out[idx] = out[idx] ? `${out[idx]} / ${text}` : text;
    }
    return out;
  }
  // 无时间戳：先在活跃段（音频反推的人声段）内按歌词顺序分布，间奏留白；否则退回均匀比例
  const lines = (lyrics || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return Array(Math.max(0, segCount)).fill('');
  const mask = Array.isArray(opts.vocalMask) && opts.vocalMask.length === segCount ? opts.vocalMask : null;
  if (mask) {
    const active = [];
    for (let i = 0; i < segCount; i++) if (mask[i]) active.push(i);
    if (active.length) {
      const out = Array(Math.max(0, segCount)).fill('');
      // 早段→晚段逐行填入，行数超过活跃段时回绕并以 ' / ' 连接；顺序保持，间奏段恒为空
      lines.forEach((line, k) => {
        const ai = active[k % active.length];
        out[ai] = out[ai] ? `${out[ai]} / ${line}` : line;
      });
      return out;
    }
  }
  // 均匀比例分配兜底（兼容旧行为 / 无位图时）
  return Array.from({ length: segCount }, (_, i) => lines[Math.floor((i * lines.length) / segCount)] || '');
}

/** 注入系统提示词的「镜头语言库」段落，强制 LLM 为每段择一运镜并写入脚本 */
export const CAMERA_LIBRARY_PROMPT = `【镜头语言库（必须从下列 10 种里为每一镜择一，并把运镜明确写进该镜的 caption 与 videoPrompt）】
${Object.values(CAMERA_MOVEMENTS)
  .map((c) => `- ${c.zh}（${c.en}）：${c.when}。英文运动描述参考："${c.enPrompt}"（仅为参考，同一运镜用在多个分镜时必须换词重写，禁止逐字复制）`)
  .join('\n')}

运镜描述变化要求（同一运镜不同分镜的英文描述必须有所区别）：
- 相对能量很高（>1.18）：用 甩镜头（紧张/转场）或 穿梭镜头（强节奏）或 跟镜头（紧跟运动主体）。
- 相对能量较高（>1.05）：用 跟镜头 / 推镜头（聚焦）/ 移镜头。
- 相对能量中等：用 摇镜头 / 移镜头；神秘情绪用 环绕镜头。
- 相对能量较低（<0.9）：用 拉镜头（展示环境）/ 升镜头（开阔）/ 降镜头（压抑）。
- 明度高偏好 拉镜头 / 升镜头（通透开阔）；明度低偏好 降镜头 / 环绕镜头（神秘内敛）。
- 歌词出现"飞/穿梭/风"→穿梭镜头；"升/高/天空"→升镜头；"落/降/沉"→降镜头；"远/海/山/世界"→拉镜头；"近/脸/眼/心"→推镜头；"跟/随/走/奔跑"→跟镜头；"转/环/绕"→环绕镜头；"摇/望/景"→摇镜头；"快/急/闪"→甩镜头；"移/穿/过/街"→移镜头。
- 整体节奏(BPM)也是重要参考：快歌（≥128 BPM）可加重 穿梭/跟/甩 等动态运镜；慢歌（<82 BPM）可加重 拉/升/降/摇 等舒缓运镜；中速则按能量与情绪择一即可（与上方「逐段视觉转译规则⑤」一致：节奏是参考，允许按人物场景微调）。
每一镜的 caption（画面描述）和 videoPrompt（图生视频提示词）都必须写明所选运镜的中文名与具体运动方式，使生成的视频运动与音乐/歌词严丝合缝，且相邻镜头运镜应有变化、避免全篇单一。`;
