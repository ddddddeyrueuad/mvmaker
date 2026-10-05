// MERT 音频特征 → 视觉语言的硬性转译规则 + 自动填充器。
// 作用：把 mert_infer.py 输出的 JSON（风格/色彩/意境/响度/节奏/能量变化）
// 直接映射为分镜所需的视觉指令（景别 / 运镜 / 转场 / 色调 / 质感），
// 供 storyboard.js 注入 LLM 系统提示词与用户输入。
//
// 对应需求里的「系统提示词(System Prompt) + JSON 数据解析模板」：
//   - MAPPING_RULES_TEXT 是写进 LLM 的固定思维链（硬性映射表）；
//   - buildMappingContext() 是 JSON 解析模板——把 MERT 数值自动翻译为
//     逐段视觉指令字符串，喂给 LLM。

// ───────────────────────────────────────────────────────────
// 1) 写进 LLM 系统提示词的硬性映射表（中文，阈值与程序化函数保持一致）
// ───────────────────────────────────────────────────────────
export const MAPPING_RULES_TEXT = `【音频→视觉 硬性转译规则（必须遵循，禁止主观发挥）】

MERT 已给出每段的 风格(style) / 配色(colorPalette) / 意境(mood) / 响度(loudness, LUFS) / 节奏(tempo, BPM) / 能量变化(energyDelta, dB)。
请严格按下表把音频特征转译为视觉元素，并写进每一镜的 imagePrompt 与 videoPrompt：

① 风格 → 材质与质感（未指定画风时默认电影感 cinematic）
  - 若用户未指定画风：全片以「电影感（cinematic）」为基础：anamorphic lens，软体积光，胶片颗粒，电影级调色
  - 若用户已指定画风（见下方【指定画风】约束）：必须完全以该画风为准，严禁混入 cinematic / anamorphic / 胶片颗粒 / 电影级调色 / 35mm / film still 等任何电影感关键词，风格描述不得与电影写实并存
  - 在此基础上叠加 MERT 推荐的具体风格方向：
  - 含 cinematic soft focus / storybook / soft volumetric → 在电影感基础上叠加柔光、温暖手绘质感
  - 含 cinematic key visual → 电影感+高饱和、清晰线稿、丰富色彩
  - 含 cinematic synthwave / cyberpunk → 电影感+霓虹、体积雾、赛博未来感
  - 含 cinematic 3d render → 纯电影感、体积光、胶片颗粒、35mm 质感

② 色彩 → 色相与色调（直接用 MERT 给的 colorPalette 作为主色，再叠加该段强调色）
  - warm orange & cream / teal & gold → 暖调、金光、互补青影
  - deep purple & cyan / monochrome blue → 冷调、蓝紫、单色蓝（忧郁用）
  - rose & indigo → 明快冷暖对比
  规则：整部作品主色调统一（取自全局 colorPalette），单段可在其上叠加该段特有强调色，做到"统一中的变化"。

③ 意境 → 画面内容与情绪元素
  - dreamy → 飘浮、柔光、缓慢上升（可选：浮尘/萤光/光斑，但不要每镜都用同一元素）
  - energetic → 爆发、奔跑、光柱交错、动态模糊（可选：飞散花瓣/水花/光带，但不要每镜都用同一元素）
  - melancholic → 雨夜、空荡、枯萎、孤独背影、低饱和
  - mysterious → 幽暗阴影、轮廓、镜中倒影、微光
  - uplifting → 阳光穿叶、花海、上升感
  - warm → 暖光、亲密、篝火感
  ★ 重要：同一情绪的多个分段不要重复使用完全相同的视觉元素——应根据歌词和场景选择不同的
    具体意象（如同为 dreamy，一段用浮尘、另一段用柔光、第三段用光斑），避免千篇一律。
  ★★ 烟雾/雾气禁令：禁止在 imagePrompt/videoPrompt 中使用 mist/fog/haze/smoke/薄雾/迷雾/烟雾/雾气
    等词汇——视频生成模型对雾极其敏感，会生成大面积白雾遮挡主体。如场景确需朦胧感，
    用"柔光/光晕/低对比"替代，不要直接写"雾"。

③-附 乐器/音色温度锚点（最高优先级约束，覆盖通用情绪配色）
  - 若音乐听感"醇厚/温暖"（如萨克斯、大提琴、原声吉他、人声吟唱、柔美铜管），
    无论其 mood 标签为何（即便标为 mysterious），一律采用「暖色夜色怀旧」基调：
    暖橙、琥珀金、暖青金为主色；主体为爵士吧人影、暖光下的街头、暖窗灯光等温暖意象。
  - 绝对禁止：把醇厚温暖的音乐映射成「太空 / 宇航员 / 赛博朋克 / 单色蓝 / 冰冷宇宙」
    等冷硬科幻主体或冷色调。温暖乐器的神秘感应体现为「夜色怀旧的氛围」，而非冰冷太空。
  - 具体冷暖以 MERT 给出的 warmth（听觉温度，0=最冷、1=最暖）为准：warmth≥0.45 即视为暖，
    配色与主体一律走暖区（见②的 warm orange & cream / teal & gold），不再受 mood 强制冷化。

③-附附 角色外貌默认设定（最高优先级）
  - ★ 所有人类主角默认为中国帅气男性或中国美丽女性（handsome Chinese man OR beautiful Chinese woman），
    必须明确性别与具体外貌描述，禁止使用 "East Asian figure / Asian person / 一个东亚人" 等模糊中性词
  - 男性默认外貌：轮廓分明（defined features）、黑发（black hair）、深棕色眼睛（dark brown eyes）、
    剑眉星目（sharp brows and eyes）、黄皮肤（warm skin tone）
  - 女性默认外貌：长发（long black hair）、精致五官（delicate features）、深棕色眼睛（dark brown eyes）、
    黄皮肤（warm skin tone）、气质优雅（elegant bearing）
  - 仅当用户或音乐文化语境明确指向其他族裔时才可更改
  - 非人类角色（精灵/神仙/动物/机器人）不受此限

④ 响度(loudness, LUFS) → 景别与景深基准（决定观众与主体心理距离；仅作基准，允许按叙事破例）
  - ≥ -10 LUFS（极响）→ 大特写/特写(Extreme Close-up/Close-up)，浅景深 f/1.2，背景极度虚化，压迫感
  - -18 ~ -10 LUFS → 中景/中近景(Medium/Medium Close-up)，中景深 f/2.8
  - -25 ~ -18 LUFS → 全景/远景(Full/Long Shot)，深景深 f/8
  - < -25 LUFS（极静）→ 大远景/极远景(Extreme Long/Wide)，无限景深 f/16，留白宏大
  ★ 景别服务于叙事，响度只是基准，以下情况可破例不服从上述映射：
    · 标注「双人/第二人物」的亲密互动段、或需突出人物表情/关系的分段 → 即使响度极低也可用中景/中近景（f/2.8，能看清人物神态），不强制极远景；
    · 标注「群像/人群」的段 → 可用全景/远景交代群体，但不必压到极远景；
    · 标注「纯景/无人物」的段 → 仍可用极远景/大远景营造留白（空镜本就无需特写）。
  总之：极静歌曲不要"每一镜都是极远景、主角永远看不清脸"——亲密与群像段应给到能看清人物的景别。

⑤ 节奏(tempo, BPM) → 运镜方式（画面动感须与音乐速度同频）
  - ≥ 140 BPM → 手持跟拍 / 快速摇镜 / 剧烈震动(Handheld/Whip Pan/Shake)
  - 110 ~ 140 BPM → 轨道推移 / 环绕飞行(Dolly/Orbit)
  - 80 ~ 110 BPM → 缓慢横移 / 升降(Slow Pan/Pedestal)
  - < 80 BPM → 静止固定 / 极慢推近(Static/Slow Push-in)
  注：节奏映射是重要参考，但运镜最终应综合"逐段分析里的建议运镜"、情绪与人物场景——允许按叙事需要微调，不必机械服从。若与「镜头语言库」的逐段建议冲突，以叙事合理为先。

⑥ 能量变化(energyDelta, dB，相邻段 RMS 差值) → 转场方式
  - 急剧上升(≥+3dB) → 快速闪白 / 冲击波转场(Flash White / Impact Zoom)
  - 温和上升(+1~3dB) → 溶解 / 叠化(Dissolve / Crossfade)
  - 持平(±1dB) → 直切(Hard Cut)
  - 下降(≤-1dB) → 缓入淡黑 / 慢速溶解(Fade to Black / Slow Dissolve)

输出要求：每一镜除了 caption / imagePrompt / videoPrompt，还必须在 segments 中填写
shotSize（景别，取自④）与 transition（转场，取自⑥）两个字段，值与下方"逐段视觉转译指令"一致。`;

// ───────────────────────────────────────────────────────────
// 2) 程序化映射函数（与 MAPPING_RULES_TEXT 阈值严格一致）
// ───────────────────────────────────────────────────────────
export function loudnessToShot(lufs, cast = '') {
  const v = typeof lufs === 'number' ? lufs : -18;
  let r;
  if (v >= -10) r = { zh: '大特写/特写', en: 'Extreme Close-up / Close-up', dof: 'shallow depth of field, f/1.2, bokeh background, extreme close-up' };
  else if (v >= -18) r = { zh: '中景/中近景', en: 'Medium / Medium Close-up', dof: 'medium depth of field, f/2.8, subject clear with softened environment' };
  else if (v >= -25) r = { zh: '全景/远景', en: 'Full / Long Shot', dof: 'deep depth of field, f/8, foreground and background both sharp' };
  else r = { zh: '大远景/极远景', en: 'Extreme Long / Wide Shot', dof: 'infinite depth of field, f/16, hyperfocal, every detail sharp' };
  // 亲密互动段（双人）不被极静响度压成极远景——给到能看清人物神态的中近景
  if (cast && cast.startsWith('双人') && (r.zh === '大远景/极远景' || r.zh === '全景/远景')) {
    return { zh: '中景/中近景', en: 'Medium / Medium Close-up', dof: 'medium depth of field, f/2.8, subject clear with softened environment' };
  }
  // 群像段最低给到全景/远景，不必压到极远景
  if (cast && cast.startsWith('群像') && r.zh === '大远景/极远景') {
    return { zh: '全景/远景', en: 'Full / Long Shot', dof: 'deep depth of field, f/8, foreground and background both sharp' };
  }
  return r;
}

export function tempoToCamera(bpm) {
  const v = typeof bpm === 'number' ? bpm : 100;
  if (v >= 140) return { zh: '手持跟拍/快速摇镜/剧烈震动', en: 'handheld follow / whip pan / shake' };
  if (v >= 110) return { zh: '轨道推移/环绕飞行', en: 'dolly / orbit' };
  if (v >= 80) return { zh: '缓慢横移/升降', en: 'slow pan / pedestal' };
  return { zh: '静止固定/极慢推近', en: 'static / slow push-in' };
}

export function deltaToTransition(delta) {
  const d = delta && typeof delta.dB === 'number' ? delta.dB : 0;
  const trend = delta && delta.trend;
  if (trend === 'sharp_rise' || d >= 3) return { zh: '快速闪白/冲击波转场', en: 'flash white / impact zoom transition' };
  if (trend === 'rise' || d >= 1) return { zh: '溶解/叠化', en: 'dissolve / crossfade' };
  if (trend === 'fall' || d <= -1) return { zh: '缓入淡黑/慢速溶解', en: 'fade to black / slow dissolve' };
  return { zh: '直切', en: 'hard cut' };
}

// 意境 → 颜色温度 + 情绪元素关键词（与 mert_infer 配色逻辑一致）
// 每种情绪提供多个候选元素，按段落序号轮选，避免同情绪段千篇一律。
// 注意：不再把"粒子(particles)"或"雾(mist/fog/haze)"作为任何情绪的元素——
// 粒子会每镜重复，雾会让视频生成模型生成大面积白雾遮挡主体。
const MOOD_VISUAL = {
  dreamy: { temp: 'cool-warm dreamy', element: [
    'soft glow, warm light leaks, drifting upward',
    'floating dust motes in warm light, dreamy bokeh',
    'soft light leaks, slow drift, delicate focus',
    'firefly-like specks of light, ethereal glow',
  ]},
  melancholic: { temp: 'cool grey-blue', element: [
    'rain on window, empty room, withered petals',
    'lone silhouette against grey sky, desaturated tones',
    'falling leaves, grey sky, quiet street',
    'dusk shadows, still water, fading light',
  ]},
  warm: { temp: 'warm amber', element: [
    'warm light, intimacy, campfire glow',
    'candlelit interior, soft golden shadows',
    'sunset warmth, amber glow, gentle embrace',
    'golden hour backlight, cozy atmosphere',
  ]},
  mysterious: { temp: 'cool indigo', element: [
    'deep shadow, obscured silhouette, mirror reflection',
    'flickering lamplight, veiled figure, deep shadows',
    'twilight shadows, obscured forms, indigo tones',
    'dim corridor, mysterious backlight, silhouettes',
  ]},
  uplifting: { temp: 'warm bright', element: [
    'sun rays through leaves, blooming flowers, rising',
    'golden hour glow, open sky, soaring perspective',
    'morning light, dew drops, blossoming scenery',
    'bright warm breeze, opening landscape, ascending',
  ]},
  energetic: { temp: 'vivid contrast', element: [
    'dynamic burst, running, intersecting light beams',
    'motion blur, wind rush, flying petals',
    'light streaks, explosive energy, kinetic movement',
    'splashing water, scattered leaves, vivid momentum',
  ]},
};

// 轻量确定性随机源（内联，避免与 storyboard.js 形成循环依赖）
function hashStrM(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function makeRngM(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 温度由独立 warmth 轴决定（与 mood 解耦）：暖→一律暖色，冷→一律冷色，
// 避免"温暖萨克斯被 mysterious 标签强行冷化成单色蓝/宇航员"。
export function moodToVisual(mood, warmth, segIndex = 0, seed = null) {
  const base = MOOD_VISUAL[(mood || '').toLowerCase()] || { temp: 'balanced', element: ['ambient motion'] };
  const elements = Array.isArray(base.element) ? base.element : [base.element];
  // seed 给定 → 同任务同段恒定、跨任务不同的随机元素；否则退回 segIndex 轮换（兼容旧调用）
  const element = seed != null
    ? elements[Math.floor(makeRngM(hashStrM(`${seed}:${segIndex}`))() * elements.length)]
    : elements[segIndex % elements.length];
  let temp = base.temp;
  if (typeof warmth === 'number') {
    if (warmth >= 0.45) temp = base.temp.includes('warm') ? base.temp : 'warm amber';
    else if (warmth < 0.35) temp = base.temp.includes('cool') ? base.temp : 'cool blue';
  }
  return { temp, element };
}

// ───────────────────────────────────────────────────────────
// 3) JSON 解析模板：把整段 MERT 分析自动填充为"逐段视觉指令"字符串
// ───────────────────────────────────────────────────────────
export function buildMappingContext(analysis, segCount, jobId = null, casts = null) {
  const a = analysis?.overall || {};
  const gE = a.energy ?? 0.5;
  const gShot = loudnessToShot(a.loudness);
  const gCam = tempoToCamera(a.tempoBpm);
  const lines = [];
  lines.push('【全局视觉基调（由 MERT 自动映射）】');
  lines.push(`- 美术风格：${a.style || '未知'}`);
  lines.push(`- 主色调：${a.colorPalette || '未知'}`);
  lines.push(`- 意境基调：${a.mood || '未知'}（${a.moodZh || ''}）`);
  lines.push(`- 听觉温度 warmth：${a.warmth ?? '未知'}（≥0.45 视为暖，配色/主体统一走暖区；<0.35 为冷区）`);
  lines.push(`- 平均响度：${a.loudness ?? '未知'} LUFS → 基准景别：${gShot.zh}（${gShot.en}）`);
  lines.push(`- 平均节奏：${a.tempoBpm ?? '未知'} BPM → 基准运镜：${gCam.zh}（${gCam.en}）`);
  lines.push('');
  lines.push('【逐段视觉转译指令（MERT 数值 → 视觉，必须逐段落实）】');
  const segs = analysis?.segments || [];
  for (let i = 0; i < segCount; i++) {
    const s = segs[i] || {};
    const cast = (casts && casts[i]) || '';
    const shot = loudnessToShot(s.loudness ?? a.loudness, cast);
    const cam = tempoToCamera(s.tempoBpm ?? a.tempoBpm);
    const trans = deltaToTransition(s.energyDelta);
    const mv = moodToVisual(s.mood, a.warmth, i, jobId);
    const rel = gE > 0 ? (s.energy / gE).toFixed(2) : '1.00';
    let deltaStr = '首段';
    if (s.energyDelta && typeof s.energyDelta.dB === 'number') {
      const d = s.energyDelta.dB;
      deltaStr = `${d > 0 ? '+' : ''}${d}dB(${s.energyDelta.trend})`;
    }
    lines.push(
      `分段${s.index != null ? s.index + 1 : i + 1} [${s.startTime ?? (s.index ?? i) * 10}s]: 意境=${s.mood}（${s.moodZh || ''}）| ` +
      `响度=${s.loudness ?? '?'} LUFS → 景别=${shot.zh}（${shot.dof}）| ` +
      `节奏=${s.tempoBpm ?? '?'} BPM → 运镜=${cam.zh}（${cam.en}）| ` +
      `能量变化=${deltaStr} → 转场=${trans.zh}（${trans.en}）| ` +
      `相对能量=${rel} | 色彩温度=${mv.temp} | 情绪元素=${mv.element}`
    );
  }
  return lines.join('\n');
}
