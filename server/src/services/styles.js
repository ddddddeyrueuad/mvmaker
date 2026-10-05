// 画风目录 + 推荐/注入辅助。纯数据，无外部依赖，前后端均可安全引用。
//
// 每个画风包含：
//   id       唯一标识
//   zh       中文名（展示）
//   en       英文名（展示）
//   promptEn 注入到英文提示词的关键词（实际发送给绘图/视频模型）
//   promptZh 中文说明（注入到中文对照 / Visual Bible）
//   signatureTokens 该画风的「特征词」（英文小写 + 中文），用于在用户选择了其它画风时，
//                   从提示词中剥离本画风的痕迹，实现「选 A 绝不出现 B」的跨风格隔离。
//                   选取原则：只用区分度高的多字短语，绝不使用会与「主体描述」冲突的裸词
//                   （如不能放裸词 'chinese'/'中国'，否则会把 "Chinese man" 主体也剥掉）。
//   recommendFor 推荐条件：命中 genre / mood 时提升推荐权重

export const STYLE_CATALOG = [
  {
    id: 'cinematic', zh: '电影写真', en: 'Cinematic Photography',
    promptEn: 'cinematic photography, film still, anamorphic lens, dramatic chiaroscuro lighting, photorealistic, 35mm film grain, shallow depth of field',
    promptZh: '电影写真感：胶片质感、宽银幕镜头、戏剧性光影、写实',
    signatureTokens: [
      'cinematic photography', 'cinematic', 'film still', 'filmic color grading', 'filmic',
      'anamorphic lens', 'anamorphic', '35mm film grain', 'film grain', 'photorealistic',
      'shallow depth of field', 'soft volumetric light', 'dramatic chiaroscuro lighting',
      '电影写真', '电影感', '电影质感', '电影级调色', '电影感调色', '电影级', '电影化', '电影',
      '胶片颗粒', '胶片质感', '胶片', '宽银幕镜头', '变形宽银幕镜头', '宽银幕', '戏剧性光影',
    ],
    recommendFor: { genres: ['Cinematic Orchestral', 'Ambient', 'Acoustic Pop'], moods: ['dreamy', 'melancholic', 'uplifting', 'warm', 'mysterious'] },
  },
  {
    id: 'chinese', zh: '中国风', en: 'Chinese Style',
    promptEn: 'Chinese traditional aesthetics, elegant Hanfu clothing, ink and mineral pigment color scheme, classical Chinese painting illustration, poetic atmosphere, refined composition, non-photorealistic',
    promptZh: '中国风：传统服饰、古典配色、诗意氛围、工笔/写意意境',
    signatureTokens: [
      'chinese traditional aesthetics', 'classical chinese painting', 'chinese style',
      'ink and mineral pigment', 'elegant hanfu', 'hanfu clothing', 'hanfu',
      '中国风', '传统服饰', '古典配色', '工笔', '写意意境', '汉服', '水墨和矿物色', '诗意氛围',
    ],
    recommendFor: { genres: ['Acoustic Pop', 'Ambient', 'Cinematic Orchestral'], moods: ['warm', 'dreamy', 'melancholic', 'mysterious'] },
  },
  {
    id: 'anime', zh: '日式动漫', en: 'Japanese Anime',
    promptEn: 'Japanese anime key visual, vibrant cel shading, 2D hand-drawn animation, expressive characters, Studio MAPPA / ufotable style, dynamic framing, rich color, non-photorealistic illustration',
    promptZh: '日式动漫：赛璐璐上色、富有表现力的角色、动态构图、鲜明色彩',
    signatureTokens: [
      'japanese anime', 'anime key visual', 'cel shading', '2d hand-drawn', 'hand-drawn animation',
      'studio mappa', 'mappa', 'ufotable', 'vibrant cel shading',
      '日式动漫', '赛璐璐上色', '赛璐璐', '二维手绘', '手绘动画',
    ],
    recommendFor: { genres: ['Lo-fi Hip-Hop', 'Future Bass', 'Synthwave'], moods: ['dreamy', 'energetic', 'uplifting'] },
  },
  {
    id: 'render3d', zh: '3D 渲染', en: '3D Render',
    promptEn: 'high quality 3d render, octane render, subsurface scattering, physically based rendering, detailed texture, polished 3d animation',
    promptZh: '3D 渲染：物理光照、细腻材质、高质量三维动画质感',
    signatureTokens: [
      '3d render', 'octane render', 'subsurface scattering', 'physically based rendering',
      'polished 3d animation', 'high quality 3d', ' pbr',
      '3d渲染', '三维渲染', '物理光照', '八面体渲染', '次表面散射',
    ],
    recommendFor: { genres: ['Cinematic Orchestral', 'Future Bass', 'Synthwave'], moods: ['energetic', 'uplifting', 'mysterious'] },
  },
  {
    id: 'cyberpunk', zh: '赛博朋克', en: 'Cyberpunk',
    promptEn: 'cyberpunk, neon lit megacity, rain-slick streets, holographic signs, chromatic aberration, high tech low life, volumetric fog',
    promptZh: '赛博朋克：霓虹都市、全息招牌、潮湿街景、高科技低生活',
    signatureTokens: [
      'cyberpunk', 'neon lit megacity', 'holographic signs', 'chromatic aberration',
      'high tech low life', 'rain-slick streets', 'volumetric fog',
      '赛博朋克', '霓虹都市', '全息招牌', '高科技低生活', '潮湿街景',
    ],
    recommendFor: { genres: ['Synthwave', 'Future Bass'], moods: ['energetic', 'mysterious'] },
  },
  {
    id: 'cganime', zh: 'CG 动画', en: 'CG Animation',
    promptEn: 'CG animated film, Pixar / Disney 3d style, smooth rigging, soft global illumination, stylized, family friendly',
    promptZh: 'CG 动画：三维卡通渲染、柔和全局光照、风格化、流畅',
    signatureTokens: [
      'cg animated film', 'cg animation', 'pixar', 'disney 3d', 'smooth rigging',
      'soft global illumination',
      'cg动画', '三维卡通渲染', '三维卡通', '皮克斯', '迪士尼', '柔和全局光照',
    ],
    recommendFor: { genres: ['Future Bass', 'Acoustic Pop', 'Lo-fi Hip-Hop'], moods: ['uplifting', 'warm', 'dreamy', 'energetic'] },
  },
  {
    id: 'inkwash', zh: '水墨', en: 'Ink Wash',
    promptEn: 'Chinese ink wash painting, sumi-e, flowing brush strokes, negative space, monochrome with subtle color, ethereal',
    promptZh: '水墨：写意笔触、留白、气韵生动、淡彩',
    signatureTokens: [
      'chinese ink wash', 'ink wash painting', 'sumi-e', 'flowing brush strokes',
      'monochrome with subtle color',
      '水墨画', '水墨', '写意笔触', '气韵生动', '留白', '淡彩',
    ],
    recommendFor: { genres: ['Ambient', 'Acoustic Pop', 'Cinematic Orchestral'], moods: ['dreamy', 'melancholic', 'mysterious', 'warm'] },
  },
  {
    id: 'oil', zh: '油画', en: 'Oil Painting',
    promptEn: 'classical oil painting, visible brushwork, rich impasto texture, chiaroscuro, museum quality, old master style',
    promptZh: '油画：厚重笔触、肌理感、明暗对比、古典质感',
    signatureTokens: [
      'classical oil painting', 'oil painting style', 'oil painting', 'visible brushwork',
      'rich impasto texture', 'impasto texture', 'impasto', 'old master style', 'old master',
      'museum quality', 'chiaroscuro', 'impressionist brushstrokes', 'impressionist',
      'brushstrokes', 'brushstroke', 'painterly',
      '古典油画', '油画风格', '油画质感', '油画', '厚重笔触', '明暗对比', '古典质感', '印象派笔触', '印象派',
      // 1.1.37 油画变体补全：让未选油画时 foreignStyleTokens 也能剥离这些词
      'oil on canvas', 'thick paint', 'canvas texture', 'heavy impasto', 'oil paint',
      'oil colors', 'oil colours', 'palette knife', 'oil-painting',
      '油画笔触', '油画感', '画布肌理',
    ],
    recommendFor: { genres: ['Cinematic Orchestral', 'Acoustic Pop'], moods: ['warm', 'melancholic', 'uplifting'] },
  },
  {
    id: 'watercolor', zh: '水彩', en: 'Watercolor',
    promptEn: 'soft watercolor illustration, wet on wet, translucent layers, paper texture, gentle pastel tones, hand painted',
    promptZh: '水彩：通透叠色、纸纹、柔和粉彩、手绘感',
    signatureTokens: [
      'watercolor illustration', 'watercolor', 'wet on wet', 'translucent layers',
      'paper texture', 'pastel tones', 'gentle pastel',
      '水彩', '通透叠色', '纸纹', '柔和粉彩', '粉彩', '手绘感',
    ],
    recommendFor: { genres: ['Lo-fi Hip-Hop', 'Acoustic Pop', 'Ambient'], moods: ['dreamy', 'warm', 'uplifting'] },
  },
  {
    id: 'cartoon', zh: '卡通', en: 'Cartoon',
    promptEn: 'flat cartoon style, bold outlines, bright flat colors, playful, storybook illustration',
    promptZh: '卡通：粗描边、明快平涂、童趣、绘本风',
    signatureTokens: [
      'flat cartoon style', 'cartoon style', 'cartoon', 'bold outlines', 'bright flat colors',
      'storybook illustration',
      '卡通风格', '卡通', '粗描边', '明快平涂', '平涂', '绘本风', '童趣',
    ],
    recommendFor: { genres: ['Lo-fi Hip-Hop', 'Acoustic Pop', 'Future Bass'], moods: ['uplifting', 'energetic', 'dreamy'] },
  },
  {
    id: 'hkanime', zh: '港风动漫', en: 'Hong Kong Style Anime',
    promptEn: 'Hong Kong retro anime aesthetic, 1990s TVB animation style, 2D anime cel shading, hand-drawn animation, neon signboards, dense city, nostalgic vibrant tone, vibrant street life, non-photorealistic illustration',
    promptZh: '港风动漫：九〇年代港片动画感、霓虹招牌、稠密街景、怀旧色调',
    signatureTokens: [
      'hong kong retro anime', 'hong kong style anime', 'tvb animation', 'tvb',
      'neon signboards', 'nostalgic vibrant tone', '1990s tvb',
      '港风动漫', '港片动画', '港片动画感', '霓虹招牌', '稠密街景', '怀旧色调', '港风',
    ],
    recommendFor: { genres: ['Synthwave', 'Lo-fi Hip-Hop', 'Future Bass'], moods: ['mysterious', 'energetic', 'dreamy'] },
  },
];

const STYLE_MAP = Object.fromEntries(STYLE_CATALOG.map((s) => [s.id, s]));

export function getStyles(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  return ids.map((id) => STYLE_MAP[id]).filter(Boolean);
}

/** 拼接选中画风的英文关键词（用逗号连接，注入英文提示词） */
export function stylePromptEn(ids = []) {
  return getStyles(ids).map((s) => s.promptEn).join(', ');
}

/** 拼接选中画风的中文说明（注入中文对照 / Visual Bible） */
export function stylePromptZh(ids = []) {
  return getStyles(ids).map((s) => `${s.zh}（${s.promptZh}）`).join('；');
}

/**
 * 收集所有「未选中」画风的特征词（用于跨风格隔离：选 A 时剥离 B/C/D… 的痕迹）。
 * 返回按长度降序排列的 token 数组（长词先剥离，避免短词先把长词切碎）。
 * @param {string[]} selectedIds 当前选中的画风 id 列表
 */
export function foreignStyleTokens(selectedIds = []) {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const tokens = [];
  for (const s of STYLE_CATALOG) {
    if (selected.has(s.id)) continue; // 选中的画风，其特征词必须保留
    for (const t of s.signatureTokens || []) if (t) tokens.push(t);
  }
  return tokens.sort((a, b) => b.length - a.length);
}

/**
 * 根据 mert 分析结果（流派/情绪）+ 歌词，给画风打分并推荐。
 * 返回与 STYLE_CATALOG 同结构的数组，并按推荐度降序，且附带 recommended 标志（前 6 名）。
 */
export function recommendStyles(analysis, lyrics) {
  const o = analysis?.overall || {};
  const genre = (o.genre || '').trim();
  const mood = (o.mood || '').trim().toLowerCase();
  const hasLyrics = Boolean(lyrics && lyrics.trim());

  const scored = STYLE_CATALOG.map((s) => {
    let score = 0;
    if (s.recommendFor.genres.includes(genre)) score += 2;
    if (s.recommendFor.moods.includes(mood)) score += 2;
    // 有歌词时，偏叙事/写实的画风略加权
    if (hasLyrics && ['cinematic', 'chinese', 'oil', 'inkwash'].includes(s.id)) score += 1;
    return { ...s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 6);
  return scored.map((s) => ({ ...s, recommended: top.includes(s) }));
}
