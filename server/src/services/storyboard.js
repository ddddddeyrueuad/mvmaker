import { config } from '../config.js';
import { chatCompletion, parseJSON } from './llm.js';
import { log, timeStep } from '../logger.js';
import { setProgress } from '../progress.js';
import { getStyles, stylePromptEn, stylePromptZh, foreignStyleTokens } from './styles.js';
import { pickCamera, CAMERA_LIBRARY_PROMPT, lyricLinesForSegs, stripLRC, buildVocalMask } from './camera.js';
import { MAPPING_RULES_TEXT, buildMappingContext, loudnessToShot, tempoToCamera, deltaToTransition } from './mapping.js';

// ── 任务级随机源（注入创意 / 随机性，同时保证同一任务内稳定一致，杜绝角色跳变 / 运镜抖动） ──
// 设计：每个 job 用 jobId 派生子随机源，使「同任务同段恒定、跨任务不同」。
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
// 由 jobId + 标签 + 序号派生稳定随机源
function rngFor(jobId, tag, idx) {
  return makeRng(hashStr(`${jobId || 'x'}|${tag}|${idx ?? 0}`));
}
function pickFrom(arr, rng) {
  if (!arr || !arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

// 已选定主角的任务级缓存：保证同一任务内每次取主角都一致（避免角色随 rng 推进而跳变）
const _subjectCache = new Map();

// 用户提供的「世界顶级动画导演」创作指令（中文）。在此之上补充双语 JSON 输出要求。
const STORYBOARD_SYSTEM_PROMPT = `你是一位享誉国际的著名音乐视频导演，拥有超过20年的行业经验，曾与多位格莱美获奖艺人合作，
作品屡获MTV音乐录影带大奖、戛纳国际创意节等顶级奖项。你以极具视觉冲击力的叙事、创新的镜头语言
和深刻的情感表达著称，擅长将音乐情绪转化为令人难忘的影像诗篇。你的核心任务是将音乐转化为分镜脚本。

【必须遵守的铁律】

（1）分镜数量 = 音频时长(秒) ÷ 10，向上取整。如果音频 210 秒，就生成 21 个分镜。每个分镜对应 10 秒视频。

（2）视觉一致性绝对不可违背：
   - 整部作品只有一个全局艺术风格，所有分镜共享同一个风格
   - 同一角色在所有分镜中：脸型、五官、发型、发色、体型完全一致
   - 同一角色在所有分镜中：服装款式、颜色、材质完全一致（可以脏/湿/破，但不能换款式）
   - 场景的光影方向、色调、氛围在连续镜头中平滑过渡，不可突变
   - 先定义 VISUAL BIBLE（视觉设定集），再写分镜

（3）故事性与叙事逻辑（最高优先级，决定 MV 是否"好看、有灵魂"，必须严格遵守）：

   【3-A 故事内核 —— 动笔前先定】
   在 visualBible 的开头，先用一句话写清全片的故事内核（Logline）：
   "主角【是谁】，渴望/珍视【什么】，却遭遇【什么阻碍或失去】，最终【如何转变 / 释怀 / 成长】。"
   其后所有分镜都必须服务于讲清这"一个"故事，而不是堆砌好看却互不相干的唯美画面。

   【3-B 五幕戏剧节拍 —— 按歌曲结构落位（具体镜号按总镜数 N 自行分配）】
   - 钩子开场（第 1 镜）：用一个"反常 / 悬念 / 强视觉冲击"的画面在前 3 秒抓住观众（如一个意味深长的特写、倒叙呈现的结果、强烈的色彩或光影反差），切忌平淡铺陈式开场。
   - 建立（Intro / 主歌前段）：交代主角、处境与情绪基调，让观众"进入"这个世界。
   - 激励事件（主歌）：打破平衡、引出核心矛盾（一次失去 / 相遇 / 抉择 / 回忆被触发）。
   - 中段反转（桥段或第二次副歌前）：至少安排 1 次明确的"转折 / 反转 / 真相揭示 / 情绪急转"，让故事不流水账。
   - 高潮（副歌最高点）：情绪与视觉的双重顶点，用最强烈的画面释放 accumulated 张力。
   - 回落与收束（尾奏）：给出"变化之后"的主角状态，留白或呼应开场，让观众有余味。

   【3-C 因果链 —— 用"因此 / 但是"连接，绝不用"然后"（叙事逻辑的核心检验法）】
   相邻两镜之间必须是"因此（therefore：前镜导致后镜）"或"但是（but：出现阻碍 / 反转 / 意外）"的关系，
   绝不能是"然后（and then：仅仅又发生了一件无关的事）"。
   检验法：把任意相邻两镜的 caption 用"……因此……"或"……但是……"连接，读起来应是一个连贯推进的故事；
   若只能用"然后"勉强连接，说明这两镜缺乏因果，必须重写其中一镜，让它承接或转折上一镜。

   【3-D 视觉母题 —— 贯穿全片、会"成长"的象征物（提升完整感与高级感）】
   设计 1 个贯穿全片的视觉母题（motif）作为故事的情感载体，例如：一朵从含苞到盛放（或凋零）的花、
   一扇从紧闭到开启的门、一盏从熄灭到点亮的灯、一只被放飞的气球、一封未寄出的信、一件被放下/拾起的旧物。
   母题在全片出现 3~4 次，且**每次状态都随剧情推进而变化**（呼应角色内心弧线：如花开=希望萌发、花落=失去、重新绽放=释怀）。
   注意区分：母题出现的镜头应彼此**隔开（不在相邻 3 镜内）**，且每次以"不同状态 / 不同角度 / 不同光影"呈现——
   母题是"会成长的象征"，不是"原地复制的道具"，因此与"相邻镜头禁用同一道具"并不冲突。

   【3-E 首尾呼应 —— 让结尾回扣开场（闭环结构，极大提升完整感与回味）】
   最后一镜应在构图、场景或母题上**呼应或反转**第一镜：
   如开场是空荡的房间、结尾是同一房间却物是人非；开场主角背对镜头、结尾主角转身面向镜头；
   开场母题处于"缺失/封闭"状态、结尾母题处于"圆满/开启"状态。

   【3-F 角色微弧线与情绪递进（原有铁律，继续遵守）】
   - 角色微弧线：主角在各分镜中应有微小的情绪/状态变化（如从迷茫→坚定、从孤独→温暖、从执念→释怀），而不是在每一镜都保持同一状态。
   - 情绪递进：分镜情绪应按音乐结构递进——Intro 建立氛围、主歌展开叙事、副歌推向高潮、桥段转折、尾奏回落。避免情绪在两镜之间突兀跳跃。
   - 音乐的情绪变化（intro→verse→chorus→bridge→outro）必须对应分镜的情绪弧线，同一情绪区间的分镜也需要有轻重的渐变。

   【3-G 非线性叙事与象征隐喻（对 3-C 因果链的补充许可，提升故事性）】
   - 在"因此/但是"的因果骨架之外，允许采用非线性叙事（倒叙 / 插叙 / 蒙太奇闪回）、象征性意象与
     抽象视觉隐喻，使画面与音乐形成更深层对话——但必须服务于故事内核，不为炫技而让观众看不懂。
   - 标志性镜头（signature shots）：在 visualBible 中明确 2~3 个"全片标志性镜头"
     （含机位、运动、灯光、象征意义），让 MV 拥有记忆点
     （如一个从天花板俯冲而下的长镜头、一面反复出现却每次状态不同的镜墙）。
   - 情绪曲线：在 visualBible 中明确写出全片"情绪曲线"（如 压抑 → 爆发 → 释然 → 余韵），
     作为各分镜情绪递进的总纲，与 3-F 的逐段情绪递进互为表里。

   【3-H 创作原则（铁律补充，拒绝平庸）】
   - 音乐是主角，画面是它的影子，而非干扰：一切镜头/构图/光影选择都要回扣音乐情绪与结构。
   - 每一帧都应有"为什么"——存在即合理；无动机的画面（纯炫技、无因果）一律剔除。
   - 拒绝陈词滥调：禁止无意义的派对、空洞的慢动作走路（行走须有情节动机，整片不得皆走）。
   - 不生成 AI 无法实现的镜头：避免"无限分形宇宙"等无技术路径的超现实堆砌；
     若追求超现实，必须给出可落地的视觉锚点（投影、镜面、粒子、实拍级特效描述）。

(4) 歌词匹配（如有歌词）：
   - 将歌词按时间段拆分，每个分镜匹配对应时间段的歌词内容
   - 画面内容必须与对应歌词段落的意思一致

（4-重中之重）歌词与 MERT 的权重分配（硬指标，必须执行）：
   总创作权重在「叙事/主角/故事」与「视觉技术处理」之间按如下比例分配：

   ★ 用户提供了歌词时（歌词不为空）—— 歌词优先，权重 7 : 3：
      - 约 70% 的创作权重来自歌词：叙事主题、主角设定（年龄/身份/时代背景）、故事走向、
        人物关系、场景意象，全部从歌词内容推导。
      - 约 30% 的创作权重来自 MERT 音频分析：仅作用于视觉技术参数——
        响度→景别、节奏→运镜、能量变化→转场、配色→色调、质感→光影，
        不决定叙事内容与主角身份。
      - MERT 给的「推荐主体/风格/配色」仅是视觉风格参考，若与歌词叙事冲突，必须忽略（以歌词 70% 为准）。
      - 主角必须是歌词叙事视角对应的角色，而不是 MERT 机械建议的预设角色。
        例：李宗盛《晚婚》讲述成年人面对婚姻的孤独反思 → 主角应是 30+ 岁成熟成年人。
        例：儿歌/童谣 → 主角可以是儿童。一切以歌词为准。
      - 歌词中的叙事视角（第一/第三人称）、人物年龄感、时代背景必须如实映射到视觉设定。

   ★ 用户未提供歌词时（歌词为空 / 纯音乐）—— 100% 由 MERT 主导：
      - 叙事/主角/故事/风格/配色/意境/主体/景别/运镜/转场 全部由 MERT 音频分析决定。
      - LLM 应完全信任 MERT 的结论，直接按「音频→视觉硬性转译规则」逐项落实。
      - 无需虚构额外的歌词叙事——仅凭音乐情绪与能量变化来构建抽象的画面叙事。

（4-附）角色外貌默认设定（贯穿全片）：
   - ★★★★★ 所有人类主角默认为中国帅气男性或中国美丽女性，必须明确性别和具体外貌：
     黑发（black hair）、深棕色眼睛（dark brown eyes）、黄皮肤（warm skin tone）、
     帅气男性：轮廓分明、剑眉星目、挺拔；美丽女性：五官精致、长发飘逸、气质优雅
   - 禁止使用「East Asian figure / Asian person / 一个东亚人」等模糊中性描述；
     必须明确写出「a handsome Chinese man ...」或「a beautiful Chinese woman ...」
   - 除非用户/歌词明确指定其他族裔或性别，否则一律按此默认
   - 允许的例外：非人类角色（精灵/神仙/动物/机器人）不受此限制
   - ★★★ 表情（facial expression）约束（适用于 imagePrompt / videoPrompt / caption）：
     全局提示词只描述外貌、服装、发色的一致性，不写任何表情词。
     每段提示词的表情描述必须含蓄内敛，贴合该段情绪基调但绝不夸张：
     - 忧郁段：用"目光低垂、微微低头、神情沉静"等含蓄描述
     - 温暖段：用"嘴角微微上扬、目光柔和"等含蓄描述
     - 昂扬段：用"目光坚定、神色舒展"等含蓄描述
     - 神秘段：用"侧脸沉静、目光深邃"等含蓄描述
     ★ 绝对禁止使用的极端表情词（中英文均禁）：
       crying, tears, tearful, sobbing, sigh, sighing, weeping, wailing, bawling,
       grimace, distorted expression, 哭泣, 流泪, 泪流, 泪眼, 叹气, 叹息, 啜泣, 哀嚎, 嚎啕, 呲牙, 表情扭曲
     违反此禁令会导致模型把角色渲染成怪异的哭泣/叹气面孔。
   - ★★★★ 场景 / 地点严禁锁死：MERT 建议主体只是「人物外貌参考」，不得把某一固定地点
     （如 'in a jazz bar' / 'by a rain-streaked window' / 'on a rooftop' / 'in a dark alley' / 'urban night scene'）
     写进全局提示词、并让所有分镜都发生在此地。每段的具体场景（室内/室外、街道/自然/城市…）
     必须由该段的歌词与情绪（segMood）独立决定，人物可随场景迁移。
     全局提示词只锁定人物本身的「外貌、服装、发色、气质/气场、统一关键光」，不锁定地点。

（4-附-附）纯景 / 无人物分镜（重要：不要给所有分镜都塞人物）：
   - 如果上方 MERT 的「建议主体」为空或标注"纯景""无"，则该分镜应为纯风光/场景/抽象画面，不含任何人物。
   - 纯景镜头类型：开场建立氛围的空镜、城市/自然远景、室内空场景、过场衔接、抽象光效/意象、留白收束。
   - 建议纯景比例：全片的 20%～30% 为纯景分镜（不宜全片无人，也不宜每镜都有人）。
   - 纯景分镜的 imagePrompt / caption 中绝不写人物描述——主体位置写场景本身（如"晨雾中空荡的远山""黄昏无人的老城街道""星光下静谧的湖面"）。
   - 这不是强制规则——如果音乐情绪明确需要角色在场，则应保留人物。此条的意图是防止把"每个画面都强行塞一个人"当成默认行为。
   - ★ 系统强制配额：本系统会在逐段分析的「人物建议」中用「纯景/无人物（空镜头，不含任何人物）」标签明确标出约 20%~30% 的分段为纯景。凡被标注为纯景的分段，你必须为它生成空镜头——画面只有风景/场景/光影/物体，绝不出现主角或任何人物；imagePrompt / videoPrompt / caption 全部以环境为主体，不要写任何人物描述。这是系统已算好的硬性占比，不得自行改成有人物的画面。

（4-群像）多人 / 群像场景（丰富叙事层次，避免全片单人独处）：
   - ★ 系统强制配额：本系统会在逐段分析的「人物建议」中用「群像/人群」或「双人/第二人物」标签明确标出约 30%~50% 的分段应为多人场景。凡被标注为这类的分段，你**必须严格照做**，不可擅自改回单人独处——这是系统已算好的硬性占比。
   - 全片不应该每一镜都是主角一个人独处。请在合适的分镜里**适当、有节奏地**引入多人或群像场景，
     让 MV 更有故事感与画面层次。但不要滥用——多人镜头总量建议占全片的 30%~50%，其余仍以主角为核心。
   - 何时引入多人（必须有依据，二选一即可）：
     ① 歌词依据：当对应时间段的歌词提到"你/我们/他们/朋友/爱人/人群/离别/相聚/家人/街上/城市"等涉及他人或群体的
        意象时，画面应出现相应的第二人物或人群（如恋人对手戏、朋友聚会、车站离别、街头行人、家庭围坐）。
     ② 音乐依据：高能量段（相对全曲能量 > 1.05，通常是副歌/桥段高潮）适合群像/热闹场景（如舞池人群、乐队合奏、
        庆典、街市喧闹）；低能量段（< 0.85，通常是主歌/间奏）适合回到主角独处或双人静场，形成"聚—散"的呼吸感。
   - 常见多人场景类型（按歌曲气质选用）：恋人/双人对手戏、三五好友、乐队/合唱、家庭团聚、车站或街头人群、
     酒吧/舞池人群、办公室/教室群体、节日庆典人群、送别/重逢场面。
   - 一致性铁律（多人时同样适用）：主角的脸型/发型/发色/服装在所有出现他的镜头里必须保持一致；
     配角/群众可以是模糊的剪影、背影、景深虚化人群，不必逐一精细设计，但整体风格、光影、色调必须与全片统一。
   - "适当随机"的含义：不要机械地每隔几镜就加一次，而要顺着叙事弧线与歌词/能量自然安排——
     开端多为主角建立、发展与高潮可引入他人与群体、尾声再回落到主角独处或双人，使人物关系服务于故事。
   - 无歌词时：仅依据能量节奏安排"聚—散"，高潮段群像、舒缓段独处，营造抽象的人群与孤独对比，不要虚构具体人物关系。

（5）每个分镜输出：
   - 镜头序号 Shot N（从 1 开始）
   - 时间段（如 0:00-0:10）
   - 景别与运镜
   - 画面描述（中文，详细，包含角色外貌、动作、环境、光影）
   - Z-Image 文生图提示词（中文，Agnes Image 2.1 Flash格式：[主体]+[场景]+[风格]+[光照]+[构图]+[质量]，80-150词）
   - Agnes Video 图生视频提示词（中文，运动控制格式：描述动态元素怎么动+不变元素怎么保持，80-120词）

（6）【音乐驱动的视觉差异化 —— 最高优先级，否则等于没用音乐】
   我在"逐段分析"里给了每一段的 情绪 / 能量（相对全曲） / 明度 / 建议运镜。你必须把这些音频特征**翻译**成具体的视觉语言，写进每一镜的 imagePrompt 与 videoPrompt（而不仅是 caption 文字里喊一句）。
   - 高能量段（相对全曲 > 1.05）：快动作、强对比光、锐利构图、动态机位（呼应"建议运镜"里的 dynamic/active）。
   - 低能量段（< 0.85）：舒缓、柔光、静态或缓慢漂浮机位、留白更多。
   - 高明明度段：高调布光（明亮、清透）；低明度段：低调/暗调（阴影重、冷暖对比）。
   - 情绪标签（energetic/uplifting/warm/melancholic/dreamy/mysterious）决定画面的情绪基调与色彩温度（暖=橙金、冷=青蓝紫、忧郁=冷灰蓝）。
   - 关键禁令：19 个 imagePrompt 绝不能千篇一律共用同一句全局提示词。每个 imagePrompt 必须含有该段特有的情绪/光影/动作描述，使生成的 19 张图在情绪与动态上明显不同。
   - 不要原样照抄英文标签（如不要把 "energetic" 直接写进 caption），而要给出对应的中文视觉化描述（如"角色迎风疾奔，背景光斑炸裂，画面充满张力"）。

（6-附）【观赏性强化 —— 让每一镜都"好看"且全片"耐看"】
   在满足叙事逻辑与音乐驱动之外，你必须主动运用以下电影化手段，提升画面的视觉吸引力与全片的观赏节奏：
   - ★ 镜头语言多样性：全片景别要有变化曲线（特写/中景/全景/远景交替），避免连续多镜同一景别。
     在情绪转折处用一次"非常规角度"制造视觉冲击（俯拍/仰拍/过肩/镜像/框中框/低机位），但每 4~5 镜至多一次，勿滥用。
   - ★ 视觉节奏（剪辑感）：高能量段用短促、密集、动感强的画面（快速运动、强烈明暗、贴近主体）；
     低能量段用长停留、留白、缓慢漂浮的画面。让"快—慢—快"的视觉节奏贴合音乐节拍，而非全片匀速。
   - ★ 构图美学：每镜有明确的构图意图与视觉重心——三分法/对称/引导线/前景遮挡/负空间留白，
     避免把主体永远怼在正中央的平庸构图。caption 中可点出该镜构图手法。
   - ★ 光影即叙事：用光影外化情绪——逆光剪影表达孤独/释怀，侧光雕刻立体与戏剧张力，
     顶光/底光制造神秘或压迫，暖光营造亲密、冷光营造疏离。让光影随叙事弧线演变（如从压抑的暗调逐步走向高潮的明亮）。
   - ★ 转场设计意识：在相邻镜头间设计有动机的视觉衔接——动作匹配剪辑、相似形状/色彩过渡、
     明暗反差切、遮挡物（门/人/物体）划过转场、同一母题的不同状态衔接。videoPrompt 可暗示衔接方向，使成片连贯不跳戏。
   - ★ 色彩情绪曲线：全片色调应随故事推进有一条可感知的演变线（如 冷灰蓝的压抑 → 青金的转机 → 暖橙的释怀/高潮），
     而非 25 镜共用同一色温。每一镜的色彩选择要服务其在叙事弧线中的位置。
   - 禁令：观赏性手段必须服务于该段情绪与叙事，不得为炫技堆砌——忧郁静场不要硬加炫目运镜，
     高潮群像不要拍成空洞空镜。一切镜头/构图/光影/转场/色彩选择都要"有理由"，理由是叙事与音乐。
   - ★ 视觉变量多样性（避免全片雷同）：相邻镜头在「人物姿态 / 取景角度 / 服装细节 / 光影处理 / 运镜」上必须明显不同，严禁连续多镜重复同一机位、同一摆位、同一构图套路；同一角色在不同分镜可呈现不同服装/发型细节/姿态以丰富视觉（但脸型/发色保持统一）。每一镜都要有"区别于上一镜"的具体视觉落点，让全片每一帧都新鲜耐看。
   - ★ 角色动作多样化，避免每一镜都是"行走"：行走是合法动作，但必须有明确叙事功能（如 转身离去/雨中独行/街头疾奔），整片行走镜占比约 1/3 且不得连续、不得每镜皆走；其余镜须用 伫立/凝望/奔跑/起舞/相拥/独坐/伸手/回眸/仰望/倚靠/驻足/俯身/抬手/转身 等多样姿态。温暖/亲密段优先静态或互动姿态；神秘/昂扬段可按情绪选用走动或静态。

【Agnes Image 2.1 Flash 格式】
六段式：[主体] + [场景/环境] + [风格] + [光照] + [构图] + [质量要求]。自然语句。主体最先。指定相机镜头增强质感。80-150词。
默认视觉风格（仅在未指定画风时）为「电影感（cinematic）」：anamorphic lens，软体积光，胶片颗粒，电影级调色，35mm 质感。若已通过【指定画风】约束指定了画风，必须完全以该画风为准，不得使用电影感关键词。

【Agnes Video V2.0 运动控制格式】
描述运动：先整体场景氛围 → 逐个动态元素 → 强调不变元素。80-120词。

★ 动态元素必须与该分镜的实际能量/情绪严格匹配（禁止千篇一律写"轻微呼吸起伏"、"缓缓叹气"）：★
- 低能量 / 忧郁 / 神秘段（energy ≤ 全曲均值×0.85，或 mood 为 melancholic/mysterious）→ 微幅动作：眼神微移/发丝轻动/衣摆轻摆/光影缓慢流动/灯光明灭，**禁止写"叹息/叹气/sigh/哭泣/流泪/crying/tears/sobbing"，禁止写"雾/薄雾/迷雾/mist/fog/haze"（视频生成会变成白雾遮挡）**
- 中能量 / 温暖 / 梦幻段（energy 在均值±15%，或 mood 为 warm/dreamy）→ 柔和流动：角色静立凝望/花瓣飘落/灯光温柔明灭/云层漂移/水面涟漪
- 高能量 / 昂扬 / 亢奋段（energy ≥ 全曲均值×1.15，或 mood 为 energetic/uplifting）→ 动感动作：奔跑/跳跃/衣摆翻飞/光柱交错/色彩迸发/风扑面
不变元素（根据分镜内容灵活选择，禁止机械复制下面示例——应写该分镜实际需要保持不变的物体/结构/背景）：
  - 人物分镜示例：保持面部五官和服装完全一致，配饰位置不变
  - 纯景分镜示例：山形轮廓不变，水面倒影位置不变，天际线建筑排列不变
  - 抽象/特效分镜示例：光源位置不变，颜色基调不变，构图重心不变

★ 人物特写皮肤柔化（针对「电影写真 / 油画」画风）：当指定画风包含电影写真(cinematic)或油画(oil painting)，且某一镜为人物特写（景别含"特写/Close-up/Extreme Close-up"，或构图为人像特写/大特写）时，
  该镜 imagePrompt 必须加入皮肤柔化描述（如 "smooth soft skin, flawless porcelain complexion, gentle beauty retouch, softened skin texture, no visible pores, remove blemishes and wrinkles"），
  避免把痘痘、皱纹、毛孔等皮肤瑕疵渲染得过于写实清晰。纯景（无人物）分镜无需此处理。
  注意：柔化是"皮肤质感平滑"，不是"把脸抹平"——保留人物五官结构与自然血色，仅去除瑕疵与过度锐利的皮肤纹理。

★ 图生视频（i2v）表情一致性（重要）：imagePrompt 生成首帧静态图，videoPrompt 驱动图生视频。
  imagePrompt 与 videoPrompt 中的角色表情必须自然、克制——禁止出现哭泣/流泪/叹气/啜泣/哀嚎等
  极端表情词（crying, tears, sobbing, sighing, weeping, wailing, 哭泣, 流泪, 叹气, 啜泣），
  否则模型会把角色面部渲染成怪异的哭泣/叹气面孔。
  同时禁止在 videoPrompt 里要求夸张的表情大幅变化
  （如"表情从 A 变为 B""突然微笑""眼眶含泪""皱眉"等），否则模型会把首帧表情扭曲成怪异表情。
  仅在情绪确实需要明显转变的分镜，才可用"表情缓缓转向……"这类平缓过渡描述，且务必保持自然。

（7）【提示词纯净度（最高优先级，否则产物丑陋）】：
   - 禁止在 imagePrompt / imagePromptZh / videoPrompt / videoPromptZh 中直接引用歌词原文（例如「隐喻歌词『...』」、visual metaphor of lyric: "..."）。歌词只用于决定画面概念与叙事走向，绝不直接写入提示词字符串；把歌词的"意思"翻译成视觉，而不是抄句子。
   - imagePromptZh / videoPromptZh 必须是通顺的中文：可保留 cinematic / anamorphic / oil painting 等英文风格专有名词，但禁止出现英文整句、英文情绪标签（如 mysterious / dreamy / melancholic / warm）或英文布光描述（如 balanced soft lighting / low-key chiaroscuro / bright high-key lighting）。情绪用中文（神秘/梦幻/忧郁/温暖/昂扬/亢奋），布光用中文（柔和平衡光/低调暗调光/明亮高调光）。
   - 每一镜的 [场景] 必须描写该 10 秒内「具体、不同」的地点/动作/事件，使全片形成视觉旅程（如 室内特写→街头中景→自然全景→人群群像→黄昏剪影），严禁每镜都写空洞重复的"主角独处"；场景随该段情绪与叙事推进自然变化。

【输出格式（必须严格遵守）】
只输出一个 JSON 对象（不要任何额外解释、不要 markdown 围栏）。字段结构如下：
{
  "visualBible": "视觉设定集（中文），须包含：①一句话故事内核(logline)；②全片情绪曲线（如 压抑→爆发→释然→余韵）；③2~3个标志性镜头及其象征意义；④全局艺术风格、主角外貌/服装/发色/体型、场景色调与光影方向",
  "globalPrompt": "文生图全局提示词（英文，Agnes Image 2.1 Flash 六段式，所有分镜共用，保证风格/角色一致）",
  "globalPromptZh": "文生图全局提示词（中文，与 globalPrompt 对应）",
  "globalVideoPrompt": "图生视频全局提示词（英文，运镜/氛围，所有分镜共用）",
  "globalVideoPromptZh": "图生视频全局提示词（中文，与 globalVideoPrompt 对应）",
  "segments": [
    {
      "shot": 1,
      "timeRange": "0:00-0:10",
      "shotSize": "景别（取自"音频→视觉硬性转译规则"④，根据该段响度选择：极响→特写，中响→中近景，较静→全景，极静→大远景）",
      "transition": "转场（取自⑥，如 直切 / 溶解）",
      "caption": "该分镜画面描述（中文，详细：角色外貌、动作、环境、光影）",
      "imagePrompt": "文生图提示词（英文，Agnes Image 2.1 Flash 六段式 [主体]+[场景]+[风格]+[光照]+[构图]+[质量]，80-150词）",
      "imagePromptZh": "文生图提示词（中文，与 imagePrompt 对应）",
      "videoPrompt": "图生视频提示词（英文，运动控制格式：先整体氛围→动态元素→不变元素，80-120词）",
      "videoPromptZh": "图生视频提示词（中文，与 videoPrompt 对应）"
    }
  ]
}
重要：实际发送给绘图/视频模型的提示词是英文（imagePrompt / videoPrompt）。请在中文画面描述之外，务必同时给出英文提示词。segments 数组的长度必须严格等于用户给出的分段数量 N。
强制要求：所有以 Zh 结尾的字段（globalPromptZh / globalVideoPromptZh / imagePromptZh / videoPromptZh）都必须填写「非空的中文译文」，绝不允许留空或省略——即使你已给出英文，也必须额外提供对应的中文。这些中文提示词会在界面上与英文并列展示给用户。

【绝对禁止重复 —— 最高优先级】
- 每一个分镜的 caption（画面描述）必须彼此不同，严禁把同一个画面复制给所有分镜。
- 每一个分镜的 imagePrompt / videoPrompt 必须彼此不同，且要体现该分镜特有的动作、机位、光影与情绪。
- 第 N 镜必须描绘"第 N 个 10 秒"里发生的具体、推进中的瞬间，而不是笼统的全局描述。
- 请利用我提供的"逐段分析（情绪/能量/运镜）"和"歌词分段"，让每一镜都呼应其对应时间段。
- 如果你发现自己在重复，请立即改为为每一镜设计独一无二的构图与动作。
- 【道具/意象去重 —— 同属最高优先级】同一个具象道具或视觉意象（如 镜子/镜面/倒影、窗/窗台、雨/雨滴、烛台/蜡烛、时钟、照片/相框、花、灯/霓虹、栏杆/天台 等）在**相邻 3 镜内不得重复作为画面核心元素出现**。即使情绪连贯、需要承接上一镜，也必须换用**不同的视觉载体**来表达同一种情绪（例如"自省/伤感"可以用镜子，也可以用雨夜窗影、空荡回廊、被风吹动的旧物、水面涟漪等替代，绝不能连续两三镜都对着镜子）。检查你已写的前序镜头：若上一镜已用某道具，本镜请主动避开它。`;

// 群像关键词：出现即强烈暗示画面应有人群 / 多人（仅保留明确指向"群体"的词，
// 去掉"街/城市/车站/家人"等不必然出现人群的环境词，避免误判泛滥）
const CROWD_WORDS = /人群|人们|人海|大家|朋友|伙伴|兄弟|姐妹|同伴|众人|派对|舞池|广场|庆典|狂欢|人潮|观众|全世界的人/;
// 双人关键词：出现即暗示画面应有第二人物（恋人 / 对手戏）
const DUO_WORDS = /我们|你我|恋|爱人|情人|拥抱|相拥|牵手|亲吻|相守|离别|分手|重逢|相遇|告别|想你|等你|念你|陪着我|陪你/;
// 纯景关键词：出现且不含人群/双人词时，强烈暗示该段适合空镜头（风景/场景/光影/物体，无人）。
// 覆盖自然/城市/天气/时间/器物等常见无人意象，驱动「根据歌词内容生成纯景空镜头」。
const SCENERY_WORDS = /山|海|河|湖|江|溪|天空|云|星|月|夜|风|雨|雪|城|街|路|窗|光|影|花|树|林|原野|旷野|荒原|草原|沙漠|黎明|黄昏|清晨|夕阳|日出|日落|自然|天地|宇宙|星河|星云|海洋|麦田|雪山|湖面|波光|暮色|夜色|晨|霞|霓虹|灯火|极光|潮汐|浪|沙|石|古城|老街|房间|屋|庭院|桥|楼|塔|彩虹|流星|萤火|雾|霜|露|田野|平原|峡谷|悬崖|礁|海岸|地平线|天际线|万家灯火|夜空|远山|静水|孤舟|扁舟|落叶|飞鸟|归鸟|雁|帆|孤帆|灯塔|渔火|炊烟/;

/**
 * 全局配额分配「单人 / 多人 / 纯景」三类人物场景（核心修复）：
 * 以全量 segments + segCount 计算配额（避免 batch=1 单段切片导致配额塌缩为全「主角独处」），
 * 先给每段按「歌词关键词 + 相对能量 + 冷暖温度」打分，再按目标比例挑出：
 *   - 纯景（约 25%，夹在 20%~30%）：从「无人群/无双人词」段中按纯景倾向降序取；
 *   - 多人（约 40%，夹在 30%~50%）：从「非纯景」段中按多人倾向降序取；
 *   - 其余 → 主角独处。
 * 这样无论歌词里群体词多寡，三类占比都稳定落在合理区间：不会全片单人、也不至于全片群像/全片空镜。
 * 返回与 segments 等长的中文人物建议数组（'纯景/无人物（空镜头，不含任何人物）' | '群像/...' | '双人/...' | '主角独处'）。
 */
export function assignCasts(segs, overall, lyricLines, segCount) {
  const N = segCount || segs.length;
  if (!N) return [];
  const gE = (overall?.energy ?? 0.5) || 0.5;
  const warmth = typeof overall?.warmth === 'number' ? overall.warmth : (overall?.energy != null ? overall.energy : 0.5);
  const scored = segs.map((s, i) => {
    const line = lyricLines[i] || '';
    const rel = gE > 0 ? (s.energy ?? gE) / gE : 1.0;
    const crowdKW = CROWD_WORDS.test(line);
    const duoKW = DUO_WORDS.test(line);
    const sceneryKW = SCENERY_WORDS.test(line) && !crowdKW && !duoKW;
    let score = 0;        // 多人倾向
    let pure = 0;         // 纯景倾向
    if (crowdKW) score += 3;
    if (duoKW) score += 2;
    if (rel > 1.12) score += 1.6;
    else if (rel > 1.0) score += 0.8;
    if (rel < 0.85) score -= 1.2;          // 低能量静场更适合独处
    if (warmth >= 0.6 && duoKW) score += 0.6; // 暖色亲密 → 略偏向双人/近景
    if (warmth < 0.35) pure += 1.0;        // 冷色疏离 → 略偏向纯景空镜
    // 纯景信号
    if (sceneryKW) pure += 2.5;            // 歌词涉及风景/场景/自然 → 强烈空镜信号
    if (rel < 0.8) pure += 1.5;            // 低能量静场适合空镜
    else if (rel > 1.15) pure -= 2;        // 高潮不适合空镜
    pure += ((i * 5 + 2) % 10) / 20;       // 轻度伪随机打破平局
    score += ((i * 7 + 3) % 10) / 20;
    return { i, rel, crowdKW, duoKW, sceneryKW, score, pure };
  });

  // 配额（与系统提示词「纯景 20%~30% / 多人 30%~50%」一致）：按全量 segCount 计算，而非切片长度。
  const pureTarget = Math.min(
    Math.floor(N * 0.3),
    Math.max(Math.ceil(N * 0.15), Math.round(N * 0.25))
  );
  const multiTarget = Math.min(
    Math.floor(N * 0.5),
    Math.max(Math.ceil(N * 0.3), Math.round(N * 0.4))
  );

  // 先选纯景：仅从「无人群词、无双人词、且确有空镜信号(pure>0)」的段中按 pure 降序取，上限 pureTarget。
  // 这样高能量/无风景词的段（pure<=0）绝不会被强行塞成空镜，空镜只落在真正适合的安静/风景段；
  // 短歌若没有空镜信号则纯景数为 0，不硬凑。
  const purePool = scored.filter((x) => !x.crowdKW && !x.duoKW && x.pure > 0);
  const pureSet = new Set(
    purePool
      .sort((a, b) => b.pure - a.pure)
      .slice(0, pureTarget)
      .map((x) => x.i)
  );
  // 再选多人：从「非纯景」段中按 score 降序取 multiTarget 个。
  const multiSet = new Set(
    scored
      .filter((x) => !pureSet.has(x.i))
      .sort((a, b) => b.score - a.score)
      .slice(0, multiTarget)
      .map((x) => x.i)
  );

  return scored.map((x) => {
    if (pureSet.has(x.i)) return '纯景/无人物（空镜头，不含任何人物）';
    if (multiSet.has(x.i)) {
      // 多人段内优先级：明确群体词→群像；明确双人词→双人（恋人对手戏不被高能量抢成群像）；
      // 无关键词时仅极高能量→群像，其余→双人，保证群像/双人有健康的混合比例。
      if (x.crowdKW) return '群像/人群（歌词涉及群体）';
      if (x.duoKW) return '双人/第二人物（歌词涉及他人）';
      if (x.rel > 1.2) return '群像/多人（高能量高潮段）';
      return '双人/第二人物（画面层次）';
    }
    return '主角独处';
  });
}

// ════════════════════════════════════════════════════════════════════════
// 全局故事大纲（Story Beat Sheet）—— 1.1.36 新增
// 解决「STORYBOARD_BATCH=1 逐镜独立生成 → 无全局弧线、主角只会走来走去」的根因：
// 在逐镜生成之前，先产出每镜的「故事节拍」，钉进逐镜 prompt，LLM 只能细化该拍，不能自由发明。
// 策略：LLM 先规划；若失败（返回非法 JSON / 长度不符 / 网络异常）则回落到纯函数确定性编排，
//       保证必有弧线、且可离线复跑（CI 友好）。
// ════════════════════════════════════════════════════════════════════════

// 每镜动作库（默认/主体动作）：按情绪分组，以静态或动态的非走路姿态为主；
// 叙事性行走见下方 MOOD_WALK_POOL，由 composeDeterministicBeats 按配额与情绪决定是否采用。
const MOOD_ACTION_POOL = {
  dreamy: [
    ['gazing into the distance, hair lifted by a soft breeze', '凝望远方，发丝被微风拂起'],
    ['floating in soft light, eyes gently closed', '柔光中漂浮，双目微阖'],
    ['reaching a hand toward falling petals', '伸手接住飘落的花瓣'],
    ['leaning back against warm grass', '向后倚靠在温软草地上'],
  ],
  melancholic: [
    ['standing still in the rain, collar turned up', '雨中伫立，衣领竖起'],
    ['sitting alone by a dim window', '独坐于昏暗窗边'],
    ['leaning against a weathered wall', '倚着斑驳老墙'],
    ['bowing the head over an old photograph', '垂首端详一张泛黄旧照'],
  ],
  mysterious: [
    ['peering into a mirror by dim lamplight', '就着昏暗灯光凝视镜中'],
    ['stepping into deep shadow', '步入幽深暗影'],
    ['unlocking a weathered wooden door', '开启一扇沧桑木门'],
    ['half-hidden behind a flowing curtain', '隐于飘动的帘幕之后'],
  ],
  warm: [
    ['wrapped in a knitted blanket by the window', '窗边裹着针织毛毯'],
    ['laughing softly under warm string lights', '暖色灯串下浅笑'],
    ['holding a steaming cup with both hands', '双手捧着一杯热饮'],
    ['leaning close to a loved one', '向身旁所爱之人依偎'],
  ],
  uplifting: [
    ['arms open to the sky, wind in hair', '迎风向天张开双臂'],
    ['spinning in a field of wildflowers', '在野花田中旋转'],
    ['leaping upward with a bright smile', '带笑腾跃而起'],
    ['reaching both arms toward the light', '举双臂迎向光明'],
  ],
  energetic: [
    ['dancing through a crowd of sparkling lights', '穿行流光人群中起舞'],
    ['mid-leap with coat flaring', '腾跃瞬间、衣摆翻飞'],
    ['throwing arms up at a live show', '在演出现场腾跃举手'],
    ['spinning with rhythmic energy', '随节奏旋身跃动'],
  ],
};
// 叙事性行走候选：带明确情节动机的"走动"（如 转身离去/雨中独行/街头疾奔），
// 仅作为"动作多样性"的一部分，由 composeDeterministicBeats 按配额（约 1/3、间隔不连续、非纯景）启用；
// 温暖/亲密段不设置行走候选（优先静态或互动姿态）。
const MOOD_WALK_POOL = {
  melancholic: [
    ['walking alone in the rain, shoulders tense', '雨中独行，双肩紧绷'],
    ['turning away and walking off into the grey', '转身离去，走入灰蒙'],
  ],
  energetic: [
    ['striding fast through neon-lit streets', '在霓虹街头大步疾行'],
    ['running across the crowded plaza', '穿过拥挤广场奔跑'],
  ],
  mysterious: [
    ['walking into deepening shadow', '步入渐浓的暗影'],
  ],
  dreamy: [
    ['drifting slowly along a quiet path', '沿静径缓缓飘行'],
  ],
  uplifting: [
    ['walking toward the light with a smile', '带笑走向光明'],
  ],
};
// 纯景段：画面以环境/母题为主体，动作写「环境动态」而非人物动作
const ENV_ACTION_POOL = [
  ['wind stirs the curtain, dust dances in the light', '风动帘幕，微尘在光里起舞'],
  ['rain ripples a quiet puddle', '雨点荡开静水涟漪'],
  ['light slowly shifts across the wall', '光线沿墙缓缓游移'],
  ['petals drift down onto still water', '花瓣飘落静水'],
  ['shadow lengthens as the sun dips', '日影渐长，暮色低垂'],
];
// 视觉旅程地点池（有序，形成地点旅行；stride 取 4 与 9 互质 → 相邻不重复）
const LOCATION_JOURNEY = [
  ['a dim, intimate interior', '昏暗而私密的室内'],
  ['a rain-streaked window at dusk', '黄昏雨痕斑驳的窗'],
  ['an empty night street, neon reflections', '空荡夜街，霓虹倒影'],
  ['a quiet transit platform', '静谧的车站月台'],
  ['a narrow alley with weathered walls', '斑驳窄巷'],
  ['open wild nature, hills and sky', '开阔旷野，山与天'],
  ['a bustling plaza at golden hour', '黄金时刻喧闹的广场'],
  ['a silhouette against stark backlight', '逆光下的剪影'],
  ['the same room, changed, years later', '同一空间，物是人非'],
];

// 母题阶段（按进度）：含苞 → 初绽 → 盛放 → 回落
function motifStage(p) {
  if (p < 0.25) return ['a bud, unopened', '含苞未放'];
  if (p < 0.5) return ['the first bloom', '初绽'];
  if (p < 0.75) return ['full bloom', '盛放'];
  return ['the bloom settling, seeds scattering', '盛放后回落，种子飘散'];
}

// 幕（act）分配：位置 + 能量曲线决定（Intro/Verse/Chorus/Bridge/Outro）
function assignActs(segs, N) {
  const e = segs.map((s) => s.energy ?? 0.5);
  const mean = e.reduce((a, b) => a + b, 0) / Math.max(1, N);
  const intro = Math.max(1, Math.round(N * 0.1));
  const outro = Math.max(1, Math.round(N * 0.1));
  let bridge = -1, minE = Infinity;
  for (let i = intro; i < N - outro; i++) if (e[i] < minE) { minE = e[i]; bridge = i; }
  let maxI = 0; for (let i = 1; i < N; i++) if (e[i] > e[maxI]) maxI = i;
  const acts = [];
  for (let i = 0; i < N; i++) {
    if (i < intro) acts.push('Intro');
    else if (i >= N - outro) acts.push('Outro');
    else if (i === bridge) acts.push('Bridge');
    else if (e[i] >= mean || i === maxI) acts.push('Chorus');
    else acts.push('Verse');
  }
  return acts;
}

// 叙事承接词（因此/但是/然而/由此/留韵）——构成因果链
function narrativeLink(act, prevAct) {
  if (act === 'Chorus' && prevAct !== 'Chorus') return '情绪因此涌起，推向高潮';
  if (act === 'Verse') return '回落到现实的细碎日常';
  if (act === 'Bridge') return '然而转折降临，揭示另一面';
  if (act === 'Outro') return '由此释然，留有余韵';
  return '承接前情，推进不歇';
}

/** 纯函数确定性故事大纲（无网络，CI 可离线复跑；同时作为 LLM 规划的兜底） */
export function composeDeterministicBeats(analysis, lyrics, segCount, casts, jobId) {
  const N = segCount;
  const segs = analysis?.segments || [];
  const a = analysis?.overall || {};
  const acts = assignActs(segs, N);
  const L = LOCATION_JOURNEY.length;
  const EN = ENV_ACTION_POOL.length;
  const beats = [];
  for (let i = 0; i < N; i++) {
    const s = segs[i] || {};
    const mood = String(s.mood || a.mood || 'dreamy').toLowerCase();
    const cast = (casts && casts[i]) || '主角独处';
    const isPure = String(cast).includes('纯景');
    const act = acts[i];
    const prevAct = i > 0 ? acts[i - 1] : null;
    const loc = LOCATION_JOURNEY[(i * 4) % L];
    let action;
    let isWalk = false;
    if (isPure) {
      action = ENV_ACTION_POOL[(i * 3) % EN];
    } else {
      const walkPool = MOOD_WALK_POOL[mood];
      // 叙事性行走配额：约每第 3 镜(i % 3 === 1)可走——间隔≥2 保证不连续；
      // 仅当该情绪有行走候选、且非纯景时才启用。整体行走占比≈1/3，其余镜为非走姿态，
      // 从而「允许行走、但绝不全片皆走」，行走由故事/情绪驱动而非默认动作。
      if (walkPool && i % 3 === 1) {
        action = walkPool[i % walkPool.length];
        isWalk = true;
      } else {
        const pool = MOOD_ACTION_POOL[mood] || MOOD_ACTION_POOL.dreamy;
        action = pool[(i * 3) % pool.length];
      }
    }
    const p = N > 1 ? i / (N - 1) : 0;
    const motif = motifStage(p);
    beats.push({
      shot: i + 1,
      act,
      emotion: s.moodZh || a.moodZh || mood,
      location: loc[1],
      locationEn: loc[0],
      action: action[1],
      actionEn: action[0],
      isWalk,
      narrativeLink: narrativeLink(act, prevAct),
      motifState: motif[1],
      motifStateEn: motif[0],
      cast,
    });
  }
  const logline = `一位在${a.moodZh || '情绪'}中徘徊的主角，从「${beats[0]?.location}」的孤身，走过「${beats[Math.floor(N / 2)]?.location}」的转折，最终在「${beats[N - 1]?.location}」与情绪和解。`;
  return { logline, beats };
}

const STORY_PLAN_SYSTEM_PROMPT = `你是顶级的 MV 故事结构师。给定一首歌的音频分析与歌词，请为 N 个 10 秒分段设计一条连贯、有灵魂的叙事弧线（故事内核 + 每镜故事节拍）。
你必须输出且仅输出一个 JSON 对象，结构为：
{
  "logline": "一句话故事内核（主角是谁、渴望/失去什么、如何转变）",
  "beats": [ { "shot": 1, "act": "Intro|Verse|Chorus|Bridge|Outro", "emotion": "该镜情绪(中文)", "location": "该镜具体地点(中文, 每镜明显不同)", "action": "该镜主角动作(中文)。允许有叙事功能的行走(如 转身离去/雨中独行/街头疾奔)，但整片行走镜占比须控制在约 1/3 且不得连续，不得每镜皆走；其余镜用 伫立/凝望/奔跑/起舞/相拥/独坐/伸手/回眸/仰望/倚靠/驻足/俯身/抬手/转身 等多样姿态", "narrativeLink": "承接上一镜的因果(用 因此/但是/然而/由此/留韵 起头)", "motifState": "视觉母题的当前阶段(含苞/初绽/盛放/回落)" } ]
}
硬性规则：
1. beats 数组长度必须恰好等于 N，shot 从 1 依次递增。
2. action 允许有叙事功能的行走（如 转身离去/雨中独行/街头疾奔），但整片行走镜占比须控制在约 1/3 且不得连续、不得每镜皆走；其余镜须用 伫立/凝望/奔跑/起舞/相拥/独坐/伸手/回眸/仰望/倚靠/驻足/俯身/抬手/转身 等多样姿态，每镜动作明显不同、贴合该段情绪与歌词。
3. location 每镜必须明显不同，整体形成一条「视觉旅程」（如 室内→窗边→街→自然→人群→剪影→同一空间物是人非）。
4. narrativeLink 用「因此/但是/然而/由此」连接上一镜，使全片构成一条因果链，而非流水账。
5. 纯景段（cast 含「纯景」）的 action 写环境/母题的动态（如「风动帘幕」「雨落水洼」），不写人物。
6. 请直接输出 JSON，不要任何解释、前言、后语与 Markdown 围栏。`;

/**
 * 从 LLM 返回里稳健提取故事大纲 JSON。
 * 背景：agnes-2.5-flash 偶尔会输出带 Markdown 围栏、前后散文、弯引号、或尾随逗号的 JSON，
 * 直接 JSON.parse 会失败（实测报 "Expected ',' or ']' after array element"），
 * 导致整轮 LLM 规划被丢弃、回落确定性兜底——等于 LLM 规划功能形同虚设。
 * 这里用「平衡大括号扫描」精准切出最外层对象（天然容忍前后散文/围栏），再做轻量修复，最大化利用 LLM 产出。
 */
function extractStoryJSON(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // 顶层若是数组（[{...},{...}]），包成 {beats:[...]}
  if (/^\s*\[/.test(t)) {
    try { return { beats: JSON.parse(repairJSON(t)) }; } catch { /* fall through */ }
  }
  const start = t.indexOf('{');
  if (start < 0) throw new Error('story JSON: 找不到对象');
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end < 0) throw new Error('story JSON: 大括号不配对');
  return JSON.parse(repairJSON(t.slice(start, end + 1)));
}
/** 轻量修复：弯引号转正 + 去尾随逗号（其余字符不动，避免误伤字符串内容）。 */
function repairJSON(s) {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/，/g, ',')
    .replace(/、/g, ',')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/,(\s*[}\]])/g, '$1');
}

// 把单拍 LLM 结果与确定性草稿 d 合并，产出最终 beat（shot 由调用方给定绝对序号）。
function mapBeat(b, d, shot) {
  const WALK_RE = /行走|独行|走入|走向|步行|徒步|踱步|溜达|漫步|缓行|walk|strid|stroll|saunter/i;
  const act = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'].includes(b.act) ? b.act : d.act;
  // 纯景（无人物）段：强制使用确定性环境动态，绝不让 LLM 写入人物/行走动作，守住「纯景空镜头」保证。
  const isPure = String(d.cast || '').startsWith('纯景') || d.noCharacter === true;
  let action, actionEn, isWalk;
  if (isPure) {
    action = d.action; actionEn = d.actionEn || ''; isWalk = false;
  } else {
    const lw = WALK_RE.test(`${b.action || ''} ${b.actionEn || ''}`);
    if (d.isWalk) {
      // 配额要求本镜行走：优先采用 LLM 的行走动作；若 LLM 未写行走则回落确定性行走动作。
      action = lw ? (b.action || d.action) : d.action;
      actionEn = lw ? (b.actionEn || d.actionEn || '') : (d.actionEn || '');
      isWalk = true;
    } else {
      // 配额要求本镜非行走：采用 LLM 动作；若 LLM 误写行走则回落确定性非行走动作。
      action = (!lw) ? (b.action || d.action) : d.action;
      actionEn = (!lw) ? (b.actionEn || d.actionEn || '') : (d.actionEn || '');
      isWalk = false;
    }
  }
  return {
    shot,
    act,
    emotion: b.emotion || d.emotion,
    location: b.location || d.location,
    locationEn: b.locationEn || d.locationEn || '',
    action,
    actionEn,
    isWalk,
    narrativeLink: b.narrativeLink || d.narrativeLink,
    motifState: b.motifState || d.motifState,
    motifStateEn: b.motifStateEn || d.motifStateEn || '',
    cast: d.cast,
  };
}

// 单个分块（≤10 拍）的 LLM 规划 + 自纠错。返回该分块的 beats（绝对 shot），logline 仅首个分块采用。
async function planStoryArcChunk(analysis, lyrics, segCount, chunkDraft, agnes, jobId, askLogline) {
  const a = analysis?.overall || {};
  const hasLyrics = !!(lyrics && String(lyrics).trim());
  const segs = analysis?.segments || [];
  const chunkBeats = chunkDraft.beats || [];
  const start = chunkBeats.length ? (chunkBeats[0].shot - 1) : 0;
  const end = start + chunkBeats.length;
  const analysisBrief = `音频整体：流派=${a.genre || '未知'}，情绪=${a.mood || '未知'}（${a.moodZh || ''}），BPM=${a.tempoBpm || '未知'}，能量=${a.energy ?? '未知'}，响度=${a.loudness ?? '未知'} LUFS。\n本段涉及的分段（绝对序号 ${start + 1}~${end}）：${segs.slice(start, end).map((s) => `${s.index + 1}:${s.mood}(${s.moodZh || ''})/E${s.energy}`).join('，')}`;
  const lyricsBrief = hasLyrics ? `歌词（已去时间戳）：\n${stripLRC(lyrics)}` : '（无歌词，纯音乐：依音频情绪与能量构建抽象叙事弧）';
  const draftBrief = `我已有一版确定性草稿（请在其基础上，结合歌词意境做更符合故事性的优化，不要推翻整体弧线结构）：\n${JSON.stringify(chunkBeats.map((b) => ({ shot: b.shot, act: b.act, emotion: b.emotion, location: b.location, action: b.action, narrativeLink: b.narrativeLink, motifState: b.motifState })))}`;
  const userContent = `请为这首歌设计 第 ${start + 1}~${end} 镜（共 ${segCount} 镜中的一段，必须恰好输出 ${chunkBeats.length} 个 beats，shot 从 ${start + 1} 到 ${end}）的故事大纲。${askLogline ? '' : '（本段无需输出 logline，只输出 beats 数组）'}\n\n${analysisBrief}\n\n${lyricsBrief}\n\n${draftBrief}\n\n输出 ${chunkBeats.length} 个 beats 的 JSON。`;
  const messages = [
    { role: 'system', content: STORY_PLAN_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
  let content;
  try {
    content = await chatCompletion(agnes, messages, { temperature: 0.7, json: true, jobId, retries: 2, timeout: 120000, baseDelayMs: 2000 });
    return finalizeChunk(content, chunkDraft, askLogline);
  } catch (e1) {
    // 自纠错重试：把原样输出回灌给模型，要求输出合法 JSON（温度调低、更确定）。
    log(jobId, 'warn', 'storyboard', `大纲分块(${start + 1}~${end}) JSON 解析失败，自纠错重试一次：${e1.message}`);
    const fixed = await chatCompletion(agnes, [
      ...messages,
      { role: 'assistant', content: String(content || '').slice(0, 1800) },
      { role: 'user', content: '你刚才的返回不是合法 JSON（解析报错：' + e1.message + '）。请只输出一个合法 JSON 对象：不要任何解释/前言/后语/Markdown 围栏；字符串内的双引号必须转义为 \\"；不要尾随逗号；键与字符串只用英文双引号。' },
    ], { temperature: 0.3, json: true, jobId, retries: 1, timeout: 120000, baseDelayMs: 2000 });
    return finalizeChunk(fixed, chunkDraft, askLogline); // 仍失败则向上抛，由 buildStoryPlan 回落确定性兜底
  }
}

function finalizeChunk(content, chunkDraft, askLogline) {
  const parsed = extractStoryJSON(content);
  if (!parsed || !Array.isArray(parsed.beats)) throw new Error('规划返回无 beats 数组');
  const chunkBeats = chunkDraft.beats || [];
  const start = chunkBeats.length ? (chunkBeats[0].shot - 1) : 0;
  if (parsed.beats.length !== chunkBeats.length) throw new Error(`规划分块 beats 长度 ${parsed.beats.length} ≠ ${chunkBeats.length}`);
  const beats = parsed.beats.map((b, i) => mapBeat(b, chunkBeats[i] || {}, start + i + 1));
  return { logline: askLogline ? (parsed.logline || chunkDraft.logline) : chunkDraft.logline, beats };
}

/**
 * 全局故事大纲 LLM 规划：把 N 拍拆成 ≤10 拍的小块分别请求再合并。
 * 根因：agnes-2.5-flash 对「一次性吐 29 拍完整 JSON + 回灌整份草稿」这类大输出会系统性返回空 content（退化），
 * 重试救不回（见 1.1.38 真歌实跑：大纲 0/4 失败）。拆小块后单批输出小 → 模型可靠；
 * 这是从根上解决大纲 100% 回落确定性的办法。外层 buildStoryPlan 仍有 4 次重试兜底。
 */
export async function planStoryArcWithLLM(analysis, lyrics, segCount, draft, agnes, jobId) {
  const CHUNK = 10;
  const totalBeats = [];
  let logline = draft.logline;
  for (let start = 0; start < segCount; start += CHUNK) {
    const end = Math.min(start + CHUNK, segCount);
    const chunkDraft = { ...draft, beats: draft.beats.slice(start, end) };
    const refined = await planStoryArcChunk(analysis, lyrics, segCount, chunkDraft, agnes, jobId, start === 0);
    if (start === 0 && refined.logline) logline = refined.logline;
    totalBeats.push(...refined.beats);
  }
  if (totalBeats.length !== segCount) throw new Error(`规划 beats 长度 ${totalBeats.length} ≠ ${segCount}`);
  return { logline, beats: totalBeats };
}

export async function buildStoryPlan(analysis, lyrics, segCount, casts, agnes, jobId) {
  const draft = composeDeterministicBeats(analysis, lyrics, segCount, casts, jobId);
  draft.source = 'deterministic';
  if (!agnes?.enabled) return draft;
  // agnes-2.5-flash 偶发「content 空 / reasoning 回声退化」，单次极易失败。
  // 外层做最多 4 次独立重试（每次都是全新 agnes 请求），对齐单镜「4 次抢救」容错强度；
  // 只要某次取到合法 JSON 即采用，最大化 LLM 规划收益，否则回落确定性编排（不 mock）。
  const ATTEMPTS = 4;
  let lastErr;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const refined = await planStoryArcWithLLM(analysis, lyrics, segCount, draft, agnes, jobId);
      refined.source = 'llm';
      log(jobId, 'info', 'storyboard', `故事大纲：LLM 规划完成（第 ${attempt + 1}/${ATTEMPTS} 次成功，${segCount} 拍，logline="${String(refined.logline || '').slice(0, 40)}…"）`);
      return refined;
    } catch (e) {
      lastErr = e;
      log(jobId, 'warn', 'storyboard', `故事大纲 LLM 规划第 ${attempt + 1}/${ATTEMPTS} 次失败（${e.message}），重试…`);
    }
  }
  log(jobId, 'warn', 'storyboard', `故事大纲 LLM 规划 ${ATTEMPTS} 次均失败（${lastErr?.message}），回落确定性编排`);
  return draft;
}

export function buildUserPrompt(analysis, lyrics, segCount, extra = '', range = null, jobId = null, casts = null, storyPlanArg = null) {
  const a = analysis?.overall || {};
  // 歌词是否存在：空白/纯空白字符视为「未提供歌词」→ 走 100% MERT 分支
  const hasLyrics = !!(lyrics && String(lyrics).trim());
  const gE = a.energy ?? 0.5;
  const allSegs = analysis?.segments || [];
  // 分批：range=[start,end) 时仅取该区间的逐段信息，使每批 prompt 体积大幅减小（避免 23 段一次性请求超时）。
  const segView = range ? allSegs.slice(range[0], range[1]) : allSegs;
  const vocalMask = buildVocalMask(allSegs, segCount);
  const lyricAll = lyricLinesForSegs(lyrics, segCount, { segDuration: 10, vocalMask });
  const lyricView = range ? lyricAll.slice(range[0], range[1]) : lyricAll;
  const castsArr = (casts && Array.isArray(casts) && casts.length) ? casts : assignCasts(allSegs, a, lyricAll, segCount);
  const castView = range ? castsArr.slice(range[0], range[1]) : castsArr;
  const plan = storyPlanArg || null;
  const beatView = plan ? (range ? plan.beats.slice(range[0], range[1]) : plan.beats) : null;
  const arcLogline = plan?.logline || '';
  const segInfo = segView
    .map((s, i) => {
      const gi = s.index != null ? s.index : i;
      const rel = gE > 0 ? (s.energy / gE).toFixed(2) : '1.00';
      const cam = pickCamera(s, a, lyricView[i] || '', rngFor(jobId, 'cam', gi));
      const cast = castView[gi] || '主角独处';
      const b = beatView ? beatView[i] : null;
      let beatLine = '';
      if (b) {
        const isPure = String(cast).includes('纯景');
        beatLine = `\n    【本镜故事大纲（必须严格采用；允许按本镜叙事需要行走，如转身离去/雨中独行，但不得脱离情节凭空行走、也不得整片皆走）】幕=${b.act}，情绪=${b.emotion}，地点=${b.location}，动作=${isPure ? '（纯景）环境动态：' + b.action : b.action}${b.isWalk ? '（本镜为叙事性行走）' : ''}${b.narrativeLink ? `，叙事功能=${b.narrativeLink}` : ''}${b.motifState ? `，母题=${b.motifState}` : ''}`;
      }
      return `分段${s.index + 1} [${s.startTime}s]: 情绪=${s.mood}（${s.moodZh || ''}）, 能量=${s.energy}（相对全曲=${rel}）, 明度=${s.brightness}, 建议运镜=${s.motion}, 推荐镜头=${cam.zh}（${cam.en}）, 人物建议=${cast}, 本段歌词=${lyricView[i] || '（纯音乐间奏，无歌词，宜纯景/氛围画面）'}${beatLine}`;
    })
    .join('\n');
  // MERT 数值 → 视觉指令的自动填充（景别/运镜/转场/色调），与系统提示词的硬性映射表一一对应
  const mappingCtx = buildMappingContext(range ? { ...analysis, segments: segView } : analysis, segView.length, jobId, range ? casts.slice(range[0], range[1]) : casts);
  return `音频整体分析：
- 流派：${a.genre || '未知'}
- 情绪：${a.mood || '未知'}（${a.moodZh || ''}）
- 速度：${a.tempoBpm || '未知'} BPM
- 能量：${a.energy ?? '未知'}
- 响度：${a.loudness ?? '未知'} LUFS
- 推荐风格（仅视觉质感，不影响叙事）：${a.style || '未知'}
- 推荐配色（仅色调方向，不影响叙事）：${a.colorPalette || '未知'}
- MERT 建议主体（仅占总权重 30% 的视觉参考，${hasLyrics ? '歌词占 70% 优先：若与歌词叙事冲突，必须忽略此建议' : '无歌词，100% 由 MERT 决定，可作为主角参考'}）：${resolveSubject(a, jobId).en || '（无建议主体——该曲可能更适合纯景/氛围画面，可酌情安排 20%~30% 分镜为纯风光场景）'}

逐段分析：
${segInfo || '（无逐段信息）'}
${plan ? `\n【全片故事弧线（你正在生成的只是其中几镜，请始终对照整体弧线为本镜定位）】\n故事内核(logline)：${arcLogline}\n各幕顺序：${plan.beats.map((b) => b.act).join(' → ')}\n` : ''}
${mappingCtx}

${hasLyrics ? `\n*** 歌词优先（占总创作权重 70%）：以下为完整歌词（已去除时间戳）。叙事主题、主角设定（年龄/身份/时代背景）、故事走向、人物关系必须从歌词推导，不可盲从上方 MERT 的「推荐主体/风格/配色」。MERT 分析仅占总权重 30%，且仅作用于视觉处理（光影/色调/质感/运镜），不决定故事内容。各分段已按真实演唱时刻对齐到对应 10 秒段（见「逐段分析」里的「本段歌词」），请让该段画面概念与此时正在演唱的歌词意境严格对应。***\n\n歌词内容：\n${stripLRC(lyrics)}\n` : '\n（用户未提供歌词 / 纯音乐：100% 依据 MERT 音频分析创作，不虚构歌词叙事）\n'}

${range ? `【本批次范围】你只需生成第 ${range[0] + 1} 到第 ${range[1]} 镜（共 ${range[1] - range[0]} 段）。segments 数组长度必须恰好为 ${range[1] - range[0]}，且每段 shot 字段从 ${range[0] + 1} 开始依次递增；其余镜由后续批次生成，不要生成。\n` : ''}请生成分段数量 N = ${range ? range[1] - range[0] : segCount} 的分镜脚本，每段对应 10 秒视频，确保 segments 数组长度恰好为 ${range ? range[1] - range[0] : segCount}。每个 segment 必须填写 shotSize 与 transition 字段（取值须与上方"逐段视觉转译指令"完全一致）。

【人物场景安排（严格遵守，这是系统已为你算好的配额，不得随意改成全单人）】上方逐段分析里每段带有「人物建议」标签，由该段能量、对应歌词行与色彩温度推导，分四类：
- 标注「纯景/无人物」的分镜：这是空镜头，画面只有风景/场景/光影/物体，**绝不出现主角或任何人物**；imagePrompt 与 caption 必须以环境为主体（如"黄昏无人的老城街道""星光下静谧的湖面"），不要写任何人物描述。全片约 20%~30% 为纯景分镜。
- 标注「双人/第二人物」的分镜：画面必须出现与主角明确互动的第二个人（恋人对手戏/朋友并肩/对视/相拥），并在 caption 与 imagePrompt/videoPrompt 中写出第二人物的外貌、动作与关系；主角保持一致。
- 标注「群像/人群」的分镜：画面必须出现多人或人群（至少 3~5 个其他人物，可用景深虚化/剪影/背影表现），主角可融入其中，营造热闹或群体氛围；全片多人镜头（双人+群像）合计约 30%~50%。
- 标注「主角独处」的分镜：聚焦主角一人，保持内省/留白，可独坐/伫立/凝望/回眸，但不必每镜都行走。
硬性配额：纯景约 25%、多人约 40%、独处约 35%（随歌词与能量自动浮动，但绝不允许全片都是单人独处）。角色动作必须多样化，避免每一镜都是"行走"——可用 伫立/凝望/奔跑/起舞/相拥/独坐/伸手/回眸/仰望/倚靠/驻足 等不同动作，且动作须贴合该段情绪与歌词。无论单人多人，主角的脸型/发型/发色/服装必须在所有镜头保持一致。${extra}`;
}

// ── 兜底分镜（音乐特征）用的中文本地化辅助 ──────────────────────────
// MERT 可能返回模糊中性主体（"East Asian figure" 等）或纯英文主体；为保证中文提示词纯中文、
// 且符合「默认中国主角」约定（mapping.js 角色默认设定），这里统一解析/净化。

// 英文配色 → 中文配色名（中文提示词专用，杜绝英文混入）
const PALETTE_ZH = {
  'monochrome blue': '单色蓝',
  'teal & gold': '青金',
  'warm orange & cream': '暖橙奶白',
  'deep purple & cyan': '深紫青',
  'rose & indigo': '玫瑰靛蓝',
};
function paletteZhOf(p) {
  if (!p) return '统一主色';
  const key = String(p).toLowerCase();
  for (const k of Object.keys(PALETTE_ZH)) if (key.includes(k)) return PALETTE_ZH[k];
  return p; // 未知颜色描述（应为中文）原样保留
}

// 模糊中性主体词（必须替换为具体中国主角）
const BANNED_SUBJECT_RE = /east asian figure|asian person|\ba generic person\b|\ba person\b|neutral[- ]?gender|gender[- ]?neutral|faceless|neutral figure/i;

// 主角多候选池：每种 (情绪, 冷暖, 性别) 组合给 2~3 个候选，变化点落在发型 / 脸型 / 光位 /
// 姿态 / 服装质感 / 配饰上（保持「中国主角」身份一致，但细节多样，注入随机性避免同类型歌雷同）。
// 性别由情绪决定（忧郁 / 亢奋→男性，其余→女性），与旧版约定一致；同一任务内用任务级 rng 选一个并锁定。
const SUBJECT_POOL = {
  'dreamy:warm': {
    female: [
      { en: 'a beautiful Chinese woman, long black hair flowing in soft wind, rosy cheeks, golden sunset glow, ethereal dreamy atmosphere', zh: '一位长发中国女性，柔风拂动黑发，暖金夕照，空灵梦幻' },
      { en: 'a beautiful Chinese woman with wispy bangs, loose braid, white linen dress, floating petals, soft focus', zh: '一位中国女性，轻薄刘海、松散麻花辫，白衣，花瓣飘落，柔焦' },
      { en: 'a beautiful Chinese woman, shoulder-length black hair, sitting by a sunlit window, gentle smile, dreamy bokeh', zh: '一位齐肩黑发中国女性，倚洒满阳光的窗边，浅笑，梦幻虚化' },
    ],
  },
  'dreamy:cold': {
    female: [
      { en: 'a beautiful Chinese woman, cool silver tones, flowing dark hair, ethereal atmosphere', zh: '一位中国女性，冷银色调，飘逸黑发，空灵氛围' },
      { en: 'a beautiful Chinese woman with straight black hair, moonlit balcony, pale blue dress, serene', zh: '一位直黑发中国女性，月光阳台，淡蓝裙，宁静' },
      { en: 'a beautiful Chinese woman, low ponytail, long hair, floating in soft blue light, dreamy', zh: '一位低马尾长发中国女性，柔蓝光影中漂浮，梦幻' },
    ],
  },
  'melancholic:warm': {
    male: [
      { en: 'a handsome Chinese man, dark hair, sharp jawline, warm amber key light, contemplative bearing', zh: '一位轮廓分明的中国男性，黑发，暖琥珀主光，内省气场' },
      { en: 'a handsome Chinese man, tousled black hair, in a dim cafe, holding a coffee, quiet melancholy', zh: '一位黑发微乱中国男性，昏暗咖啡馆中捧着咖啡，静默忧郁' },
      { en: 'a handsome Chinese man, short black hair, standing in rain, collar turned up, pensive gaze', zh: '一位短黑发中国男性，雨中伫立，衣领竖起，沉思目光' },
    ],
  },
  'melancholic:cold': {
    male: [
      { en: 'a handsome Chinese man, dark hair, soft cold light, contemplative bearing, cinematic solitude', zh: '一位黑发中国男性，柔冷光，内省气场，电影感孤独' },
      { en: 'a handsome Chinese man, damp black hair, by a fogged window, blue-grey tones, lonely', zh: '一位黑发微湿中国男性，立于起雾窗边，蓝灰色调，孤寂' },
      { en: 'a handsome Chinese man, short dark hair, standing in snow, collar turned up, breath visible, muted cold', zh: '一位短黑发中国男性，雪中伫立、衣领竖起，呵气可见，冷调静默' },
    ],
  },
  'mysterious:warm': {
    female: [
      { en: 'a beautiful Chinese woman, long black hair, warm amber lamplight, red lips, cinematic noir', zh: '一位长发中国女性，暖琥珀灯光，红唇，电影感暗调' },
      { en: 'a beautiful Chinese woman in a red qipao, half-hidden in shadow, smoking lamplight, enigmatic', zh: '一位身着红旗袍中国女性，半隐于影，昏黄灯光，神秘莫测' },
      { en: 'a beautiful Chinese woman, long hair, veil, through warm curtain of light, enigmatic aura', zh: '一位长发蒙纱中国女性，穿过暖色光帘，神秘气息' },
    ],
  },
  'mysterious:cold': {
    female: [
      { en: 'a beautiful Chinese woman in a black coat, long hair, deep blue shadows, enigmatic, cold', zh: '一位黑衣长发中国女性，深蓝暗影，神秘，冷调' },
      { en: 'a beautiful Chinese woman, silver-streaked hair, peering through frosted glass, enigmatic', zh: '一位挑染银发中国女性，凝望结霜玻璃，神秘' },
      { en: 'a beautiful Chinese woman, pale makeup, standing in cold moonlight, veiled, mysterious', zh: '一位淡妆中国女性，冷月光中伫立，蒙纱，神秘' },
    ],
  },
  'warm:warm': {
    female: [
      { en: 'a beautiful Chinese woman bathed in golden lamplight, long flowing black hair, cinematic warmth, elegant bearing', zh: '一位长发中国女性，沐浴金色灯光，电影感暖调，优雅气场' },
      { en: 'a beautiful Chinese woman in a knit sweater, curly black hair, laughing under warm string lights', zh: '一位中国女性，针织衫，卷黑发，暖色灯串下含笑' },
      { en: 'a beautiful Chinese woman, bob haircut, holding a steaming cup, cozy window seat, gentle warmth', zh: '一位波波头中国女性，捧着热饮，温馨窗边，柔和暖意' },
    ],
  },
  'warm:cold': {
    female: [
      { en: 'a beautiful Chinese woman, long black hair, cool twilight, soft ambient light, elegant', zh: '一位长发中国女性，微凉暮色，冷调环境光，优雅' },
      { en: 'a beautiful Chinese woman in a grey cardigan, sitting by a window at dusk, gentle', zh: '一位灰开衫中国女性，黄昏窗边，温柔' },
      { en: 'a beautiful Chinese woman, bob hair, holding a warm cup in a cool room, soft contrast', zh: '一位波波头中国女性，冷室中捧热饮，柔和对比' },
    ],
  },
  'uplifting:warm': {
    female: [
      { en: 'a beautiful Chinese woman in warm radiant sunlight, long black hair, elegant posture, graceful stance', zh: '一位长发中国女性，暖阳中，身姿优雅' },
      { en: 'a beautiful Chinese woman with a high ponytail, arms open on a hilltop, wind in hair, joyful', zh: '一位高马尾中国女性，山顶张开双臂，发随风扬，欢欣' },
      { en: 'a beautiful Chinese woman, short bob, spinning in a field of wildflowers, bright smile', zh: '一位短波波头中国女性，野花田中旋转，灿烂笑容' },
    ],
  },
  'uplifting:cold': {
    female: [
      { en: 'a beautiful Chinese woman in cool morning light, long hair flowing, graceful stance', zh: '一位长发中国女性，冷调晨光，发丝飘动，优雅' },
      { en: 'a beautiful Chinese woman, high ponytail, on a frosty hilltop, arms open, crisp joy', zh: '一位高马尾中国女性，霜顶张开双臂，清冽欢欣' },
      { en: 'a beautiful Chinese woman, short bob, in a bright cold field, bright smile, fresh', zh: '一位短波波头中国女性，清冷旷野中，灿烂笑容，清新' },
    ],
  },
  'energetic:warm': {
    male: [
      { en: 'a handsome Chinese man in radiant golden light, dynamic motion, sharp features, dark hair', zh: '一位黑发中国男性，灿烂金光中动态运动，五官凌厉' },
      { en: 'a handsome Chinese man, sweat-dampened black hair, mid-leap, athletic build, vivid energy', zh: '一位黑发微汗中国男性，腾跃瞬间，运动身形，鲜活能量' },
      { en: 'a handsome Chinese man, spiky dark hair, dancing through crowd, confident grin, kinetic', zh: '一位刺头黑发中国男性，穿行人群起舞，自信笑意，动感' },
    ],
  },
  'energetic:cold': {
    male: [
      { en: 'a handsome Chinese man in dramatic cool lighting, intense motion, sharp features, dynamic composition', zh: '一位黑发中国男性，冷调戏剧光，强烈动态，凌厉构图' },
      { en: 'a handsome Chinese man, slicked dark hair, sprinting through neon rain, vivid cold energy', zh: '一位油头黑发中国男性，霓虹雨中疾奔，冷冽鲜活能量' },
      { en: 'a handsome Chinese man, spiky dark hair, leaping in blue stage light, confident, kinetic', zh: '一位刺头黑发中国男性，蓝调舞台光中腾跃，自信，动感' },
    ],
  },
};

function subjectGenderOf(mood) {
  return (mood === 'melancholic' || mood === 'energetic') ? 'male' : 'female';
}
function subjectPoolFor(mood, isWarm) {
  const key = `${mood}:${isWarm ? 'warm' : 'cold'}`;
  const group = SUBJECT_POOL[key] || SUBJECT_POOL['dreamy:warm'];
  return group[subjectGenderOf(mood)] || group.female;
}
/** 按情绪+冷暖从多候选池随机挑一个主角（任务级 rng 驱动，保证同任务一致、跨任务不同） */
function pickSubject(mood, isWarm, rng) {
  const pool = subjectPoolFor(mood, isWarm);
  return pickFrom(pool, rng) || { en: 'a handsome Chinese man, dark hair', zh: '一位黑发中国男性' };
}
// 旧函数保留作兼容（返回池首元素，供已停用 mockStoryboard 等使用）
function subjectEnForMood(mood, isWarm) {
  return subjectPoolFor(mood, isWarm)[0].en;
}
function subjectZhForMood(mood, isWarm) {
  return subjectPoolFor(mood, isWarm)[0].zh;
}

// 由 MERT overall 解析出「合规」主体：英文 + 中文。模糊中性词一律替换为具体中国主角。
// 同一 jobId 内锁定已选主角（任务级缓存），避免角色随随机源推进而跳变。
export function resolveSubject(o, jobId) {
  if (jobId && _subjectCache.has(jobId)) return _subjectCache.get(jobId);
  const mood = o?.mood || 'dreamy';
  const warmth = typeof o?.warmth === 'number' ? o.warmth : (o?.energy != null ? o.energy : 0.5);
  const isWarm = warmth >= 0.45;
  const raw = (o?.suggestedSubject || '').trim();
  // 仅当 MERT 显式标「无/无人物/纯景/无主体」时才视为无主角；不再用能量硬阈值强行判定，
  // 以免整片无人物（纯景由 assignCasts 配额另行保证 20%~30%）。
  let result;
  if (!raw || ['无', '无人物', '纯景', '无主体'].includes(raw)) {
    result = { en: '', zh: '' };
  } else if (BANNED_SUBJECT_RE.test(raw)) {
    result = pickSubject(mood, isWarm, rngFor(jobId, 'subject', 0));
  } else {
    result = { en: raw, zh: subjectZhForMood(mood, isWarm) };
  }
  if (jobId) _subjectCache.set(jobId, result);
  return result;
}

// 由冷暖轴决定兜底风格（与配色一致，避免「冷配色 + 暖风格」矛盾，如 monochrome blue + warm glow）
function styleForWarmth(isWarm) {
  return isWarm
    ? { en: 'cinematic, warm tone, soft volumetric light, gentle atmospheric glow, film grain, filmic color grading', zh: '电影质感、暖色调、柔和体积光、温暖氛围、胶片颗粒' }
    : { en: 'cinematic, cool tone, soft volumetric light, calm muted atmosphere, film grain, filmic color grading', zh: '电影质感、冷色调、柔和体积光、静谧氛围、胶片颗粒' };
}

const MOOD_ZH_LOCAL = { dreamy: '梦幻', energetic: '亢奋', melancholic: '忧郁', uplifting: '昂扬', mysterious: '神秘', warm: '温暖' };

// 【已停用】mockStoryboard 不再被调用。坚决杜绝 mock 降级：generateStoryboard 在 agnes
// 不可用时直接抛错，绝不静默降级。函数定义保留仅供将来参考，不影响运行时行为。
function mockStoryboard(analysis, lyrics, segCount) {
  const o = analysis?.overall || {};
  const subj = resolveSubject(o);
  const hasSubject = Boolean(subj.en);
  const warmth = typeof o.warmth === 'number' ? o.warmth : (o.energy != null ? o.energy : 0.5);
  const isWarm = warmth >= 0.45;
  const stl = styleForWarmth(isWarm);
  const styleEn = stl.en;
  const styleZh = stl.zh;
  const palette = o.colorPalette || (isWarm ? 'teal & gold' : 'monochrome blue');
  const paletteZh = paletteZhOf(palette);
  const mood = o.mood || 'dreamy';
  const moodZh = o.moodZh || MOOD_ZH_LOCAL[mood] || mood;
  const visualBible = hasSubject
    ? `主角：${subj.zh}（脸型、发色、服装在全程保持一致）。整体风格：${styleZh}。色调：${paletteZh}。光影：侧逆光，柔和体积光。`
    : `纯景/氛围（无固定人物角色）。整体风格：${styleZh}。色调：${paletteZh}。光影：侧逆光，柔和体积光。风景与场景为主要视觉内容。`;
  const globalPrompt = hasSubject
    ? `${styleEn}, ${palette} color palette, featuring ${subj.en}, consistent character design across all shots, highly detailed, 8k`
    : `${styleEn}, ${palette} color palette, scenery and landscape, no human characters, atmospheric establishing shots, highly detailed, 8k`;
  const globalPromptZh = hasSubject
    ? `整体风格：${styleZh}；配色：${paletteZh}；主角：${subj.zh}；所有分镜保持角色与风格一致；高细节 8k。`
    : `整体风格：${styleZh}；配色：${paletteZh}；纯景/氛围画面，无人物的风景与场景；高细节 8k。`;
  // 全局视频运镜：按能量决定速度描述
  const camSpeed = (o.energy ?? 0.5) >= 0.7 ? 'dynamic' : ((o.energy ?? 0.5) >= 0.4 ? 'smooth cinematic' : 'slow atmospheric');
  const camSpeedZh = (o.energy ?? 0.5) >= 0.7 ? '动感' : ((o.energy ?? 0.5) >= 0.4 ? '流畅电影感' : '缓慢氛围感');
  const globalVideoPrompt = `${camSpeed} camera movement, ${mood} atmosphere, ${palette} color grading${hasSubject ? ', keep character and style consistent across shots' : ', pure scenery and landscapes, no human characters'}`;
  const globalVideoPromptZh = `${camSpeedZh}运镜，${moodZh}氛围，${paletteZh}色调${hasSubject ? '；保持角色与风格在镜头间一致。' : '；纯风景画面，无人物的场景。'}`;
  const castLines = lyricLinesForSegs(lyrics, segCount);
  const casts = assignCasts(analysis?.segments || [], o, castLines);
  const segments = [];
  for (let i = 0; i < segCount; i++) {
    const s = (analysis?.segments || [])[i] || {};
    const segMood = s.mood || mood;
    const segMoodZh = s.moodZh || MOOD_ZH_LOCAL[segMood] || segMood;
    const motion = s.motion || 'gentle drift';
    const energy = s.energy ?? 0.5;
    const light = s.brightness >= 0.6 ? '明亮高调光' : (s.brightness <= 0.35 ? '低调暗调光' : '柔和平衡光');
    const shot = loudnessToShot(s.loudness ?? o.loudness);
    const trans = deltaToTransition(s.energyDelta);
    const cast = casts[i] || '主角独处';
    const castEn = cast.startsWith('群像') ? 'a lively crowd of background figures (silhouettes, shallow depth of field)'
      : cast.startsWith('双人') ? 'a second person interacting with the main character' : 'alone';
    const castZh = cast.startsWith('群像') ? '身处人群/群像中' : cast.startsWith('双人') ? '与第二个人物互动' : '独处';
    // 逐段差异化场景（按情绪 + 镜序轮换）→ 每镜前缀即不同，彻底杜绝「千篇一律共用一句全局提示词」
    const scene = sceneVariation(segMood, i);
    const caption = hasSubject
      ? `第${i + 1}镜（${i * 10}-${(i + 1) * 10}s）：${scene.zh}，${shot.zh}，${motion}，${light}，${segMoodZh}情绪，能量${energy.toFixed(2)}，${castZh}。${subj.zh}置身${paletteZh}色调场景。`
      : `第${i + 1}镜（${i * 10}-${(i + 1) * 10}s）——纯景/氛围：${scene.zh}，${shot.zh}，${motion}，${light}，${segMoodZh}情绪，${paletteZh}色调的空旷场景。`;
    const imagePrompt = hasSubject
      ? `${scene.en}, ${segMood} mood, ${castEn}, ${shot.dof}, ${motion}, ${light}, energy ${energy.toFixed(2)}, ${styleEn}, ${palette} color palette, featuring ${subj.en}, detailed environment`
      : `${scene.en}, ${segMood} mood, ${castEn}, ${shot.dof}, ${motion}, ${light}, energy ${energy.toFixed(2)}, ${styleEn}, ${palette} color palette, scenery and landscape, no human characters, detailed environment`;
    const imagePromptZh = hasSubject
      ? `${scene.zh}，${segMoodZh}情绪，${castZh}，${shot.zh}，${motion}，${light}，能量${energy.toFixed(2)}，${paletteZh}配色，${subj.zh}，${styleZh}。`
      : `${scene.zh}，${segMoodZh}情绪，${castZh}，${shot.zh}，${motion}，${light}，能量${energy.toFixed(2)}，${paletteZh}配色，${styleZh}（纯景）。`;
    // 逐段 video 运动描述：按该段能量决定动态程度
    const segMotion = (energy >= 0.7) ? 'energetic and dynamic motion, active camera tracking'
      : (energy >= 0.4) ? 'smooth flowing motion, gentle camera drift'
      : 'slow atmospheric drift, barely perceptible movement';
    const videoPrompt = hasSubject
      ? `${scene.en}, ${motion}, ${shot.dof}, ${segMood} mood, ${castEn}, energy ${energy.toFixed(2)}, ${segMotion}, keep ${subj.en} consistent, cinematic`
      : `${scene.en}, ${motion}, ${shot.dof}, ${segMood} mood, pure scenery, no humans, ${segMotion}, cinematic`;
    const videoPromptZh = hasSubject
      ? `${scene.zh}，${shot.zh}，${motion}，${segMoodZh}情绪，${castZh}，能量${energy.toFixed(2)}，细微的连续运动，保持${subj.zh}一致，电影感。`
      : `${scene.zh}，${shot.zh}，${motion}，${segMoodZh}情绪，纯景无人，风景元素的细微连续运动，电影感。`;
    segments.push({
      shot: i + 1,
      timeRange: `${i * 10}:00-${(i + 1) * 10}:00`.replace(/(\d+):(\d+)-(\d+):(\d+)/, (_, a, b, c, d) => `${a}:${b.padStart(2, '0')}-${c}:${d.padStart(2, '0')}`),
      shotSize: shot.zh,
      transition: trans.zh,
      caption, imagePrompt, imagePromptZh, videoPrompt, videoPromptZh,
    });
  }
  return { visualBible, globalPrompt, globalPromptZh, globalVideoPrompt, globalVideoPromptZh, segments };
}

// 从模型可能返回的多种「合法但非标准」结构中尽力取出 segments 数组。
// 注意：这属正确解析，不是 mock 降级——模型确实产出了分镜，只是外层包裹形态不同。
// 常见变种：顶层数组 [{…}] / {data:[…]} / {shots:[…]} / {storyboard:{segments:[…]}} / {output:{segments}} / {result:{segments}}。
function locateSegments(board) {
  if (!board) return null;
  if (Array.isArray(board.segments)) return board.segments;
  if (Array.isArray(board)) return board;                                  // 顶层数组
  if (Array.isArray(board.data)) return board.data;                       // {data:[…]}
  if (Array.isArray(board.shots)) return board.shots;                     // {shots:[…]}
  if (Array.isArray(board.storyboard?.segments)) return board.storyboard.segments; // {storyboard:{segments}}
  if (Array.isArray(board.output?.segments)) return board.output.segments;
  if (Array.isArray(board.result?.segments)) return board.result.segments;
  return null;
}

export function normalize(board, segCount) {
  const segs = locateSegments(board);
  if (!segs) throw new Error('分镜结构异常');
  // 顶层数组形态：包成对象以便携带 segments 字段
  if (Array.isArray(board)) board = { segments: segs };
  else board.segments = segs;
  if (board.segments.length > segCount) board.segments = board.segments.slice(0, segCount);
  while (board.segments.length < segCount) {
    const i = board.segments.length;
    const prev = board.segments[i - 1] || {};
    board.segments.push({
      shot: i + 1,
      timeRange: `${i * 10}:00-${(i + 1) * 10}:00`.replace(/(\d+):(\d+)-(\d+):(\d+)/, (_, a, b, c, d) => `${a}:${b.padStart(2, '0')}-${c}:${d.padStart(2, '0')}`),
      caption: prev.caption || `第${i + 1}镜（补全）`,
      imagePrompt: `${board.globalPrompt || ''} shot ${i + 1}`,
      imagePromptZh: prev.imagePromptZh || '',
      videoPrompt: `${board.globalVideoPrompt || ''} shot ${i + 1}`,
      videoPromptZh: prev.videoPromptZh || '',
    });
  }
  // 1.1.40 修复：内容质量校验——截断自愈/抢救重试后 imagePrompt/caption 可能为空、占位符(…)
  // 或仅含风格词，导致 applyStylesToStoryboard 注入风格前缀后 imagePrompt 只剩风格词、无场景描述。
  // 不合格则抛异常，由上层 repairAndParseStoryboard 触发格式强约束重生成（而非接受残缺内容）。
  // 实测正常段 imagePrompt≥561 字符、caption≥128 字符；异常段 imagePrompt≤143、caption≤3。
  for (const s of board.segments) {
    const shotLabel = s.shot || '?';
    const cap = String(s.caption || '').trim();
    if (!cap || /^\.{2,}$/.test(cap) || cap.length < 10) {
      throw new Error(`分镜结构异常（第${shotLabel}镜 caption 内容缺失）`);
    }
    const img = String(s.imagePrompt || '').trim();
    if (!img || /^\.{2,}$/.test(img) || img.length < 150) {
      throw new Error(`分镜结构异常（第${shotLabel}镜 imagePrompt 内容过短 ${img.length} 字符）`);
    }
    // 去掉常见风格词后检查是否还有实质场景/人物描述
    const styleWords = /cinematic|photography|film\s*still|anamorphic|lens|dramatic|chiaroscuro|lighting|photorealistic|film\s*grain|depth\s*of\s*field|soft\s*focus|volumetric|35mm|bokeh|color\s*graded|grainy|vintage/gi;
    const imgSubstantive = img.replace(styleWords, '').replace(/[,\s]+/g, ' ').trim();
    if (imgSubstantive.length < 40) {
      throw new Error(`分镜结构异常（第${shotLabel}镜 imagePrompt 仅有风格词无场景描述）`);
    }
    // 场景指示词检测：imagePrompt 必须含至少一个场景/人物/动作/物件词，
    // 否则即使长度达标也只是风格词堆砌（如 "cool muted atmosphere soft light gentle"）
    const SCENE_INDICATORS = /\b(woman|man|person|girl|boy|figure|character|people|crowd|standing|sitting|walking|gazing|looking|holding|wearing|dress|hair|eyes|face|hand|arm|shoulder|back|silhouette|street|room|sky|tree|mountain|window|door|building|landscape|forest|ocean|river|bridge|car|chair|table|flower|leaf|sun|moon|cloud|rain|snow|wind|fire|candle|lamp|neon|piano|guitar|microphone|steps?|stairs|wall|floor|ceiling|horizon|meadow|valley|cliff|path|road|alley|cafe|bar|stage|studio)\b/i;
    if (!SCENE_INDICATORS.test(img)) {
      throw new Error(`分镜结构异常（第${shotLabel}镜 imagePrompt 缺少场景/人物描述）`);
    }
  }
  return board;
}

/**
 * 把可能被截断/格式错误的 JSON 文本尝试修复为可解析对象（纯本地、无网络调用）。
 * 提取首个 { 起到末尾，区分字符串内外逐字符重建：字符串值内的裸控制字符
 * （换行/回车/Tab）转义为 \n \r \t，补全未闭合的字符串与括号后解析。
 * 仅当文本确含 { 且能补全解析时才返回对象，否则返回 null（交给上层重生成）。
 *
 * 修复历史：旧实现直接基于原文本切片补全，若 Agnes 用 ```json 围栏且截断落在
 * 字符串值内（围栏换行落入未闭合字符串），裸换行会让修复后仍是非法的 JSON → 整段失败。
 * 现改为重建式扫描，字符串内控制字符一律转义，覆盖围栏截断场景。
 */
export function tryTruncateRepair(text) {
  const raw = String(text || '');
  const s = raw.indexOf('{');
  if (s < 0) return null;
  let t = raw.slice(s);
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  let inStr = false, esc = false;
  const stack = [];
  const pairs = { '{': '}', '[': ']' };
  let out = '';
  let topClosed = false; // 最外层对象已闭合后，丢弃其后所有字符（只取首个完整对象）
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (topClosed) continue;
    if (inStr) {
      if (esc) { out += c; esc = false; }
      else if (c === '\\') { out += c; esc = true; }
      else if (c === '"') { out += c; inStr = false; }
      else if (c === '\n') out += '\\n';
      else if (c === '\r') { /* 丢弃裸回车 */ }
      else if (c === '\t') out += '\\t';
      else out += c;
    } else {
      if (c === '"') { out += c; inStr = true; }
      else if (c === '{' || c === '[') { out += c; stack.push(c); }
      else if (c === '}' || c === ']') {
        if (stack.length && pairs[stack[stack.length - 1]] === c) {
          out += c; stack.pop();
          if (stack.length === 0) topClosed = true; // 最外层对象闭合，后续散文一律丢弃
        } else out += c; // 多余闭合引号/括号：宽松保留，不破坏后续解析
      } else out += c;
    }
  }
  if (inStr) out += '"';
  while (stack.length) out += pairs[stack.pop()];
  try {
    const obj = JSON.parse(out);
    if (obj && typeof obj === 'object') return obj;
  } catch { /* ignore */ }
  return null;
}

/**
 * 解析分镜 JSON，多级自愈，降低 agnes 偶发截断/裸引号/散文回复导致的单镜失败：
 *   1) 标准 parseJSON；2) 未转义引号修复（本地）；3) 截断修复（本地，无额外调用）；
 *   4) 两轮「格式强约束重生成」——第 2 轮变换温度并去掉 json_object 约束，打断回声退化死循环。
 * 仍失败则抛出原错误，交由外层抢救/整轮熔断（不 mock）。
 */
/** 格式强约束重生成的超时（与 generateStoryboard 的 BATCH_TIMEOUT 同量级，此处独立定义，避免跨函数作用域引用未定义变量） */
const REPAIR_TIMEOUT = 300000;

/** 检测模型「复述任务退化」：content 空、或 reasoning_content 只是回声 user prompt（以任务复述开头、无 JSON 字段标志）。 */
export function looksLikeEcho(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/"segments"\s*:/.test(t)) return false;
  return /^(用户要求|用户希望|用户需要|我需要|我要生成|首先|好的|根据要求|本镜|这一镜)/.test(t);
}

/**
 * 修复字符串值内未转义的双引号（agnes 高负载常见故障：把对白里的裸引号直接写进
 * caption/imagePrompt → 解析报 "Expected ',' or '}' after property value"）。
 * 启发式：字符串内的引号，若其后首个非空白字符属于「结构信号」→ 真闭合引号，否则视为内容并转义为 \"。
 * 结构信号 = , : } ] 或已到文末。合法 JSON 里值闭合引号后必跟 , } ] : 之一，从不直接跟文字或另一个引号，
 * 而对白引号后面永远是文字（她/你/好…）——这正是区分对白引号与结构引号的关键特征，故不把 " 列入结构信号。
 * 返回修复后的文本（不保证可解析，可能仍需 tryTruncateRepair 补全截断）；无 { 时返回 null。
 */
export function repairUnescapedQuotes(text) {
  const raw = String(text || '');
  const s = raw.indexOf('{');
  if (s < 0) return null;
  const t = raw.slice(s);
  let inStr = false, esc = false, out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { out += c; esc = false; }
      else if (c === '\\') { out += c; esc = true; }
      else if (c === '"') {
        let j = i + 1;
        while (j < t.length && (t[j] === ' ' || t[j] === '\t' || t[j] === '\r' || t[j] === '\n')) j++;
        const nx = j < t.length ? t[j] : '';
        const isClosing = nx === ',' || nx === ':' || nx === '}' || nx === ']' || nx === '';
        if (isClosing) { out += c; inStr = false; }
        else out += '\\"';
      } else out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  if (inStr) out += '"';
  return out;
}

/** 本地修复链：标准解析 → 未转义引号修复 → 截断修复。全部本地、无网络调用；失败抛首个错误。 */
export function parseWithLocalRepairs(text, norm, jobId, segLabel) {
  const t = String(text || '');
  try {
    return norm(parseJSON(t));
  } catch (e1) {
    // 2) 值内裸引号修复（可与截断叠加：修复引号后再走截断补全）
    const q = repairUnescapedQuotes(t);
    if (q && q !== t) {
      try { return norm(parseJSON(q)); } catch { /* 继续尝试截断组合 */ }
      const rq = tryTruncateRepair(q);
      if (rq) {
        try {
          const ok = norm(rq);
          log(jobId, 'info', 'storyboard', `${segLabel} 分镜 JSON 含未转义引号/截断，本地自愈修复成功（无需重生成）`);
          return ok;
        } catch { /* 继续 */ }
      }
    }
    // 3) 截断/损坏 JSON：本地结构修复（无额外网络调用）
    const repaired = tryTruncateRepair(t);
    if (repaired) {
      try {
        const ok = norm(repaired);
        log(jobId, 'info', 'storyboard', `${segLabel} 分镜 JSON 被截断/损坏，本地自愈修复成功（无需重生成）`);
        return ok;
      } catch {
        // 本地修复仅过语法关，内容不完整导致结构校验未过 → 交给下方格式强约束重生成
        log(jobId, 'warn', 'storyboard', `${segLabel} 本地自愈修复后结构校验未通过，转格式强约束重生成…`);
      }
    }
    throw e1;
  }
}

const REGEN_VARIANT_DESC = { 1: '', 2: '，变换温度并改用非 json 约束' };

/** 格式强约束重生成：variant=1 低温+json_object；variant=2 高温+去掉 json_object 约束并把指令移到 user 侧（打断回声退化死循环）。输出同样走本地修复链。 */
async function regenStoryboardOnce(agnes, mkMessages, jobId, segLabel, norm, variant) {
  const v2 = variant === 2;
  const msgs = mkMessages(v2 ? '' : '\n\n【强制格式】你必须且只能输出一个 JSON 对象，禁止任何解释、前言、后语与 Markdown 围栏。');
  if (v2) {
    const last = msgs[msgs.length - 1];
    msgs[msgs.length - 1] = { role: last.role, content: (last.content || '') + '\n\n【强制格式】不要复述任务要求、不要输出任何解释，直接以 { 开始输出一个完整 JSON 对象。' };
  }
  const fixed = await chatCompletion(agnes, msgs, {
    temperature: v2 ? 0.9 : 0,
    json: !v2,
    jobId, retries: 2, timeout: REPAIR_TIMEOUT, baseDelayMs: 1000,
  });
  return parseWithLocalRepairs(fixed, norm, jobId, segLabel);
}

export async function repairAndParseStoryboard(content, agnes, jobId, segLabel, expectSegs, mkMessages) {
  const norm = (obj) => normalize(obj, expectSegs);
  const text = String(content || '');
  const hasJson = text.includes('{');
  // agnes-2.5-flash 偶发 content 空、仅回退 reasoning_content 且其中无 JSON（模型回声 user prompt 退化）。
  // 此类回复本地修复无意义，直接进入两轮差异化重生成（第 2 轮换温度/去 json 约束，避免同 prompt 同退化循环）。
  if (!hasJson || looksLikeEcho(text)) {
    if (typeof mkMessages === 'function') {
      let lastErr = null;
      for (const variant of [1, 2]) {
        try {
          log(jobId, 'warn', 'storyboard', `${segLabel} 模型未返回合规 JSON（content 空/回声退化），触发格式强约束重生成（第 ${variant}/2 轮${REGEN_VARIANT_DESC[variant]}）…`);
          return await regenStoryboardOnce(agnes, mkMessages, jobId, segLabel, norm, variant);
        } catch (e2) { lastErr = e2; }
      }
      log(jobId, 'warn', 'storyboard', `${segLabel} 格式强约束重生成仍失败（${lastErr?.message || lastErr}），回退原错误`);
      throw new Error('模型未返回合规 JSON（content 空/回声退化）');
    }
    throw new Error('模型未返回合规 JSON（content 空/回声退化）');
  }
  // 有 JSON 迹象：本地修复链（标准解析 → 引号修复 → 截断修复）
  try {
    return parseWithLocalRepairs(text, norm, jobId, segLabel);
  } catch (e1) {
    // 本地修复仍不合规：两轮格式强约束重生成
    if (typeof mkMessages === 'function') {
      let lastErr = null;
      for (const variant of [1, 2]) {
        try {
          log(jobId, 'warn', 'storyboard', `${segLabel} 模型未返回合规 JSON（本地修复后仍不合规），触发格式强约束重生成（第 ${variant}/2 轮${REGEN_VARIANT_DESC[variant]}）…`);
          return await regenStoryboardOnce(agnes, mkMessages, jobId, segLabel, norm, variant);
        } catch (e2) { lastErr = e2; }
      }
      log(jobId, 'warn', 'storyboard', `${segLabel} 格式强约束重生成仍失败（${lastErr?.message || lastErr}），回退原错误`);
      throw e1;
    }
    throw e1;
  }
}

/** 合并分批分镜后，按最终数组顺序重排 shot / timeRange（分批返回时各批的 shot 多为局部编号） */
function renumberSegments(board) {
  (board.segments || []).forEach((s, i) => {
    s.shot = i + 1;
    const a = i * 10, b = (i + 1) * 10;
    s.timeRange = `${a}:00-${b}:00`.replace(/(\d+):(\d+)-(\d+):(\d+)/, (_, x, y, z, w) => `${x}:${y.padStart(2, '0')}-${z}:${w.padStart(2, '0')}`);
  });
  return board;
}

/** 唯一 caption / imagePrompt 数量，用于检测 LLM 是否把段落生成得完全一样 */
function uniqueCounts(board) {
  const caps = new Set((board.segments || []).map((s) => (s.caption || '').trim())).size;
  const imgs = new Set((board.segments || []).map((s) => (s.imagePrompt || '').trim())).size;
  return { caps, imgs };
}

/** imagePrompt 前 N 字符的去重数（忽略大小写/空白），用于检测"千篇一律共用一句全局提示词" */
function distinctImagePrefixes(board, len = 42) {
  const set = new Set();
  for (const s of board.segments || []) {
    const p = (s.imagePrompt || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, len);
    if (p) set.add(p);
  }
  return set.size;
}

/** 音乐特征 → 视觉布光/动态提示，供兜底重建时把逐段音频差异写进 imagePrompt */
function lightingCue(s) {
  const b = s.brightness ?? 0.5;
  if (b >= 0.6) return 'bright high-key lighting, airy and luminous';
  if (b <= 0.35) return 'low-key chiaroscuro lighting, deep shadows, strong contrast';
  return 'balanced soft lighting';
}

/** 中文布光描述（英文 lightingCue 仅用于英文 prompt；中文镜必须用中文，禁止英文布光句） */
function lightingCueZh(s) {
  const b = s.brightness ?? 0.5;
  if (b >= 0.6) return '明亮高调光，清透通透';
  if (b <= 0.35) return '低调暗调光，阴影浓重、冷暖对比强烈';
  return '柔和平衡光';
}

const MOOD_ZH_FALLBACK = { dreamy: '梦幻', energetic: '亢奋', melancholic: '忧郁', mysterious: '神秘', uplifting: '昂扬', warm: '温暖' };

/** 逐镜差异化场景库（英文 + 中文），按情绪分组、按镜序轮换，
 * 保证兜底重建时每一镜的「地点/动作」明显不同，避免全片雷同。 */
const SCENE_POOL = {
  dreamy: [
    ['floating among drifting clouds at dawn', '晨光中漂浮于流动云层间'],
    ['lying in a sunlit meadow, petals falling', '躺在洒满阳光的草甸，花瓣飘落'],
    ['gazing through a rain-streaked window', '隔着雨痕斑驳的窗凝望外面'],
    ['standing amid serene bamboo, light filtering through', '伫立于幽静竹林，光影斑驳'],
    ['submerged in a luminous pool of light', '沉浸于流光般的通透水景'],
  ],
  melancholic: [
    ['standing alone in the rain on an empty street', '独自在雨中空街伫立'],
    ['sitting by a dim window at dusk', '黄昏时独坐于昏暗窗边'],
    ['standing on an empty station platform', '立于空荡的车站月台'],
    ['leaning against a wall in a narrow alley', '倚在窄巷斑驳墙边'],
    ['looking at a faded photograph by lamplight', '就着台灯端详泛黄旧照'],
  ],
  mysterious: [
    ['stepping through deep shadow and dim light', '步入幽深暗影'],
    ['peering into a mirror by dim lamplight', '就着昏暗灯光凝视镜中'],
    ['wandering a labyrinth of old stone corridors', '穿行古老石廊的迷宫'],
    ['a silhouette against a moonlit curtain', '映于月光帘幕前的剪影'],
    ['unlocking a weathered wooden door', '开启一扇沧桑木门'],
  ],
  warm: [
    ['sharing a close moment by a campfire', '篝火旁亲密相偎'],
    ['laughing under warm string lights', '暖色灯串下含笑'],
    ['holding a steaming cup in a cozy room', '在温馨屋里捧着热饮'],
    ['standing hand in hand at golden hour', '黄金时刻携手伫立'],
    ['wrapped in a knitted blanket by the window', '窗边裹着毛毯'],
  ],
  uplifting: [
    ['running down a sun-dappled forest path', '奔向林间斑驳光影的小径'],
    ['arms open on a hilltop with the wind', '山顶迎风张开双臂'],
    ['spinning in a field of wildflowers', '野花田中旋转'],
    ['leaping over a stream with a bright smile', '带笑跃过溪流'],
    ['rising with balloons into a clear sky', '随气球升入晴空'],
  ],
  energetic: [
    ['sprinting down a neon-lit street', '在霓虹街道上疾奔'],
    ['jumping with arms thrown up at a live show', '在演出现场腾跃举手'],
    ['dancing through a crowd of sparkling lights', '穿行于流光人群中起舞'],
    ['riding into the night with wind in hair', '夜色中疾驰、发随风扬'],
    ['leaping from a rooftop, coat flaring', '自屋顶腾跃、衣摆翻飞'],
  ],
};

/** 取第 i 镜的场景（按情绪分组、镜序轮换），返回 {en, zh}。 */
function sceneVariation(mood, i, seed) {
  const pool = SCENE_POOL[mood] || SCENE_POOL.dreamy;
  if (!pool || !pool.length) return { en: '', zh: '' };
  if (seed == null) return { en: pool[i % pool.length][0], zh: pool[i % pool.length][1] };
  // 用任务级 rng 对 pool 做稳定 Fisher-Yates 洗牌，取打乱后第 i 个 → 同任务同 mood 顺序稳定、跨任务不同
  const rng = rngFor(seed, 'scene', mood);
  const arr = pool.map((p) => p);
  for (let k = arr.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [arr[k], arr[j]] = [arr[j], arr[k]];
  }
  const pick = arr[i % arr.length];
  return { en: pick[0], zh: pick[1] };
}

/** 中文动态描述（相对能量 → 动感程度），供兜底重建写进中文视频提示词。 */
function segMotionZh(rel) {
  if (rel >= 1.15) return '动感十足的运动，活跃的镜头追踪';
  if (rel >= 0.85) return '流畅流动的运动，镜头轻柔漂移';
  return '缓慢氛围化漂移，几乎难以察觉的微动';
}


/** 终极兜底：保证每段 caption 互不相同（必要时追加镜头序号），避免出现两段完全相同的字幕 */
function forceUniqueCaptions(board) {
  const seen = new Set();
  for (const s of board.segments || []) {
    let base = (s.caption || '').trim() || `第${(s.shot || 0)}镜`;
    let c = base;
    let n = 1;
    while (seen.has(c)) {
      n += 1;
      c = `${base}（镜头 ${n}）`;
    }
    seen.add(c);
    s.caption = c;
  }
  return board;
}

/** 把每段选定的运镜（中文名 + 英文名）挂到分镜上，供前端展示「灵活运镜」徽章 */
function attachCamera(board, analysis, lyrics, segCount, jobId = null) {
  const a = analysis?.overall || {};
  const lines = lyricLinesForSegs(lyrics, segCount);
  (board.segments || []).forEach((seg, i) => {
    const s = (analysis?.segments || [])[i] || {};
    const cam = pickCamera(s, a, lines[i] || '', rngFor(jobId, 'cam', i));
    seg.cameraMovement = cam.zh;
    seg.cameraMovementEn = cam.en;
  });
  return board;
}

/**
 * 把「人物场景建议」挂到最终分镜的每段上，供前端/生图使用：
 * - seg.cast：中文标签（纯景/无人物 / 群像/人群 / 双人/第二人物 / 主角独处）
 * - seg.noCharacter：纯景段为 true，使 /api/images/generate-one 走 t2i 的 noCharacter 分支，
 *   强制纯风光（剥离全局人物提示词 + "pure scenery, no humans"），让「纯景空镜头」真正落地，
 *   而不是被全局 prompt 里的主角描述覆盖。
 * 重算时使用与 buildUserPrompt 完全相同的 assignCasts（基于全量 segments + segCount），
 * 因此得到的标签与生成时 LLM 收到的「人物建议」一致。
 */
function attachCast(board, analysis, lyrics, segCount, jobId = null) {
  const a = analysis?.overall || {};
  const lines = lyricLinesForSegs(lyrics, segCount);
  const casts = assignCasts(analysis?.segments || [], a, lines, segCount);
  (board.segments || []).forEach((seg, i) => {
    const cast = casts[i] || '主角独处';
    seg.cast = cast;
    seg.noCharacter = cast.startsWith('纯景');
  });
  const pure = casts.filter((c) => c.startsWith('纯景')).length;
  const multi = casts.filter((c) => c.startsWith('群像') || c.startsWith('双人')).length;
  log(jobId, 'info', 'storyboard', `人物场景配额：纯景 ${pure}/${segCount}，多人 ${multi}/${segCount}，独处 ${segCount - pure - multi}/${segCount}`);
  return board;
}

/** 保证所有中文（Zh）字段非空：若模型漏填中文译文，调用一次翻译补全，避免界面中文提示词消失 */
/**
 * 包装一个长耗时的异步调用：在等待期间每 15s 刷新一次进度心跳，
 * 避免 LLM 生成 / 中文翻译等长请求（长曲可达数十秒）期间界面误判"卡死"。
 */
function withKeepAlive(jobId, percent, label, detail, fn) {
  const ka = setInterval(() => setProgress(jobId, { percent, label, detail }), 15000);
  return Promise.resolve().then(fn).finally(() => clearInterval(ka));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 翻译补全对象的轻量归一化：仅校验/提取 *Zh 字段，不做分镜结构强校验。
 * 1.1.45 修复：旧代码复用分镜 normalize 会因翻译段缺 caption/imagePrompt 必抛
 * 「分镜结构异常」，导致成功翻译也被丢弃、中文提示词始终回退英文（功能名存实亡）。
 */
function normZh(o) {
  const segs = Array.isArray(o?.segments) ? o.segments : [];
  return {
    globalPromptZh: typeof o?.globalPromptZh === 'string' ? o.globalPromptZh : '',
    globalVideoPromptZh: typeof o?.globalVideoPromptZh === 'string' ? o.globalVideoPromptZh : '',
    segments: segs.map((s) => ({
      imagePromptZh: typeof s?.imagePromptZh === 'string' ? s.imagePromptZh : '',
      videoPromptZh: typeof s?.videoPromptZh === 'string' ? s.videoPromptZh : '',
    })),
  };
}

/**
 * 1.1.45 加固：中文提示词补全两轮差异化重试，打断回声退化死循环。
 *   轮1=温度0.3+json 约束；轮2=温度0.7+去 json 约束+强制格式指令移 user 侧。
 * 回声退化（content 空/复述任务）短路转下一轮；解析走本地修复链
 * （标准解析→未转义引号修复→截断修复），与分镜自愈一致。
 */
export async function translateZh(payload, agnes, jobId, chatFn = chatCompletion) {
  const sys = '你是专业译者。把给定的英文文生图/图生视频提示词准确翻译为简体中文，保留专业术语、风格词与品牌名，语句自然流畅。只输出一个 JSON（不要多余解释）：{"globalPromptZh":"...","globalVideoPromptZh":"...","segments":[{"imagePromptZh":"...","videoPromptZh":"..."}]}，segments 顺序与输入严格一致、数量相同。';
  const userCore = JSON.stringify(payload);
  const variants = [
    { temperature: 0.3, json: true,  suffix: '' },
    { temperature: 0.7, json: false, suffix: '\n\n【强制格式】你必须且只能输出一个 JSON 对象，禁止任何解释、前言、后语与 Markdown 围栏。' },
  ];
  let lastErr;
  for (let v = 0; v < variants.length; v++) {
    const { temperature, json, suffix } = variants[v];
    try {
      const content = await withKeepAlive(
        jobId, 90,
        'Agnes LLM 正在补全中文提示词…',
        `模型=${agnes.chatModel}`,
        () => chatFn(
          agnes,
          [
            { role: 'system', content: sys },
            { role: 'user', content: userCore + suffix },
          ],
          // 翻译是展示增强（缺中文仅影响界面文案，英文提示词正常），agnes 不可用时不应死等：
          // 收紧到 1 次重试 + 60s 超时，避免在整盘已熔断兜底的场景下再空耗数十秒。
          { temperature, json, jobId, retries: 1, timeout: 60000 }
        )
      );
      // 回声退化短路：content 空/复述任务 → 直接转下一轮，避免误导性 parse 错误日志
      if (looksLikeEcho(content)) {
        lastErr = new Error('模型回声退化（未返回翻译 JSON）');
        log(jobId, 'warn', 'storyboard', `中文提示词补全第 ${v + 1} 轮返回回声退化，转下一轮重试…`);
        continue;
      }
      return parseWithLocalRepairs(content, normZh, jobId, '中文提示词补全');
    } catch (e) {
      lastErr = e;
      log(jobId, 'warn', 'storyboard', `中文提示词补全第 ${v + 1} 轮失败（${(e.message || e).toString().slice(0, 80)}），转下一轮重试…`);
    }
  }
  throw lastErr || new Error('中文提示词补全失败');
}

export async function ensureZh(board, agnes, jobId, chatFn = chatCompletion) {
  const needGlobal = !((board.globalPromptZh || '').trim()) || !((board.globalVideoPromptZh || '').trim());
  const segsMissing = (board.segments || []).filter(
    (s) => !((s.imagePromptZh || '').trim()) || !((s.videoPromptZh || '').trim())
  );
  if (!needGlobal && segsMissing.length === 0) return board; // 已齐全，零额外开销
  log(jobId, 'debug', 'storyboard', `检测到 ${(needGlobal ? 2 : 0) + segsMissing.length} 处中文提示词缺失，发起翻译补全…`);
  if (!agnes?.enabled) {
    log(jobId, 'warn', 'storyboard', 'agnes 未启用，无法补全中文提示词（仅影响展示，英文提示词正常）');
    return board;
  }
  const payload = {
    globalPrompt: board.globalPrompt || '',
    globalVideoPrompt: board.globalVideoPrompt || '',
    segments: (board.segments || []).map((s) => ({ imagePrompt: s.imagePrompt || '', videoPrompt: s.videoPrompt || '' })),
  };
  try {
    const t = await translateZh(payload, agnes, jobId, chatFn);
    board.globalPromptZh = (board.globalPromptZh || '').trim() || (t.globalPromptZh || '').trim() || board.globalPromptZh || '';
    board.globalVideoPromptZh = (board.globalVideoPromptZh || '').trim() || (t.globalVideoPromptZh || '').trim() || board.globalVideoPromptZh || '';
    board.segments = (board.segments || []).map((s, i) => {
      const ts = (t.segments || [])[i] || {};
      return {
        ...s,
        imagePromptZh: (s.imagePromptZh || '').trim() || (ts.imagePromptZh || '').trim() || '',
        videoPromptZh: (s.videoPromptZh || '').trim() || (ts.videoPromptZh || '').trim() || '',
      };
    });
    log(jobId, 'debug', 'storyboard', '中文提示词补全完成');
  } catch (e) {
    log(jobId, 'warn', 'storyboard', `中文提示词补全失败，保留原值：${e.message}`);
    // 1.1.40 修复：补全失败时用英文提示词兜底，避免 applyStylesToStoryboard 注入风格前缀后
    // videoPromptZh/imagePromptZh 只剩风格词无场景内容（实测第 23/27 镜 videoPromptZh=31 字符=仅风格前缀）
    if (!(board.globalPromptZh || '').trim()) board.globalPromptZh = board.globalPrompt || '';
    if (!(board.globalVideoPromptZh || '').trim()) board.globalVideoPromptZh = board.globalVideoPrompt || '';
    for (const s of (board.segments || [])) {
      if (!(s.imagePromptZh || '').trim()) s.imagePromptZh = s.imagePrompt || '';
      if (!(s.videoPromptZh || '').trim()) s.videoPromptZh = s.videoPrompt || '';
    }
  }
  return board;
}

// 默认电影风格（cinematic oil painting 等）关键词：当用户选择了其它画风时，必须从所有提示词中剥离，
// 否则会出现「日式动漫 … 电影感油画风格」这类默认电影风格与所选画风并存的问题。
// 这些词来自 STORYBOARD_SYSTEM_PROMPT 的「默认视觉风格为电影感」指令，是 LLM 在"未指定画风"时
// 写进 globalPrompt / imagePrompt / visualBible 的默认渲染风格描述。
const CINEMATIC_DEFAULT_TOKENS = [
  // 中文油画/印象派
  '电影感油画风格', '电影感油画', '电影感油画质感', '电影感（cinematic）', '电影感',
  '印象派笔触', '印象派',
  '油画风格', '油画质感', '油画',
  // 英文油画/笔触（LLM 在英文 prompt 中的高频输出）
  'oil painting style, ', 'oil painting style',
  'oil painting, ', 'oil painting',
  'impressionist brushstrokes, ', 'impressionist brushstrokes',
  'impressionist, ', 'impressionist',
  'brushstrokes, ', 'brushstrokes', 'brushstroke, ', 'brushstroke',
  'painterly, ', 'painterly',
  'impasto texture, ', 'impasto texture', 'impasto, ', 'impasto',
  'chiaroscuro, ', 'chiaroscuro',
  // 电影风格（中文）
  '胶片颗粒', '电影级调色', '电影感调色', '电影级',
  '电影质感', '电影风格', '电影化', '电影画面', '电影镜头', '电影运镜',
  '35mm 质感', '35mm质感', '35毫米质感',
  '变形宽银幕镜头', '宽银幕镜头', '宽银幕',
  '电影', // 裸词兜底：长词（电影感/电影级/电影质感等）先匹配，残余的「电影般的」「电影叙事」等变体由裸词清除
  // 电影风格（英文）—— 必须含 cinematic 核心词本身，否则残留 cinematic 会与非电影画风叠加，导致风格摇摆/部分镜变写实
  'cinematic photography, ', 'cinematic photography',
  'cinematic 3d animation, ', 'cinematic 3d animation',
  'cinematic lighting, ', 'cinematic lighting',
  'cinematic noir, ', 'cinematic noir',
  'cinematic warmth, ', 'cinematic warmth',
  'cinematic solitude, ', 'cinematic solitude',
  'cinematic style, ', 'cinematic style',
  'cinematic, ', 'cinematic',
  'filmic color grading, ', 'filmic color grading',
  'film still, ', 'film still',
  'soft volumetric light, ', 'soft volumetric light',
  '35mm film grain', 'anamorphic lens', 'anamorphic', 'film grain',
  // ── 1.1.37：补齐常见变体（精确串漏网导致风格污染再现）──
  // 电影感变体（LLM 高频但不在原列表的写法）
  '35mm', 'anamorphic lens flare', 'color graded', 'bokeh', 'vintage film', 'grainy',
  '电影氛围', '电影色调', '电影叙事', '电影画面',
  // 写实（非写实画风下的污染词）
  '写实摄影', '写实照片', '写实质感', '写实风格', '写实画面',
  // 油画专属变体（必须剥离，否则非油画画风会混入油画肌理/笔触导致画面粗糙）
  'oil on canvas', 'thick paint', 'canvas texture', 'heavy impasto', 'oil paint',
  'oil colors', 'oil colours', 'palette knife', 'oil-painting',
].sort((a, b) => b.length - a.length);

/** 把默认电影风格关键词从一段文本中剥离（用于注入新画风前清除旧默认） */
function stripCinematicDefault(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  for (const tok of CINEMATIC_DEFAULT_TOKENS) {
    if (tok) t = t.split(tok).join('');
  }
  // 清理剥离后残留的连续标点/空白，避免 "，，"/"  "
  t = t
    .replace(/[，,\s]*[，,][，,\s]*/g, '，')
    .replace(/\s{2,}/g, ' ')
    .replace(/，([。；：])/g, '$1')
    .replace(/(?<!整体)风格：[，,。\s]*/g, '') // 去掉被剥离后残留的空"风格："子句（只吞标点/空白，不吞中文内容；保留"整体风格："供下方替换）
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
    .trim();
  return t;
}

/**
 * 跨风格隔离：把指定 token 列表（其它画风的特征词）从文本中剥离。
 * 英文不区分大小写匹配（LLM 输出大小写不稳定），中文按原样匹配。
 * 用于「选 A 绝不出现 B」——在注入所选画风前，先清掉所有未选中画风的痕迹。
 */
function stripForeignStyleTokens(text, tokens) {
  if (!text || typeof text !== 'string' || !tokens?.length) return text;
  let t = text;
  for (const tok of tokens) {
    if (!tok) continue;
    // 英文 token 用大小写不敏感的正则转义匹配；纯中文 token 也走同一逻辑（escapeRegExp 对中文无副作用）
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(escaped, 'gi'), '');
  }
  // 清理剥离后的连续标点/空白
  t = t
    .replace(/[，,\s]*[，,][，,\s]*/g, '，')
    .replace(/\s{2,}/g, ' ')
    .replace(/，([。；：])/g, '$1')
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
    .trim();
  return t;
}

/** 把选中的画风关键词注入已有分镜的提示词（不重跑 LLM，即时生效） */
export function applyStylesToStoryboard(board, styleIds) {
  if (!board) return board;
  const styles = getStyles(styleIds);
  // 1.1.37 修复：未选画风（styleIds 为空）时不再原样返回、完全不清理。
  // 此时视为「默认电影写真」——保留电影感，但剥离任何其它画风（油画/动漫/水墨…）的痕迹，
  // 否则 LLM 在默认路径下误吐的油画词会因 styleIds 为空而残留，造成「风格互相污染 / 画面粗糙」。
  const effSelected = (styleIds && styleIds.length) ? styleIds : ['cinematic'];
  const en = stylePromptEn(styleIds);                 // 空 → ''（默认电影感已由 LLM 产出，不重复前缀）
  const zh = stylePromptZh(styleIds) || (styles.length ? '' : '电影写真（默认风格）');
  const foreign = foreignStyleTokens(effSelected);
  // 仅当选了某画风时才剥离默认电影词（默认路径保留电影感）；无论何种情况都剥离未选中画风痕迹。
  const clean = (s) => {
    const t = stripForeignStyleTokens(s, foreign);
    return styles.length ? stripCinematicDefault(t) : t;
  };
  // 前缀：未选画风时 en/zh 为空，避免残留 ", " / 多余空格
  const preEn = en ? `${en}, ` : '';
  const preZh = zh ? `${zh} ` : '';

  // 视觉设定集：先剥离默认电影风格词 + 其它画风痕迹，再把「整体风格：…」替换为当前选中画风，并清除历史上
  // 即时应用追加的「画风：…」行，避免反复换画风时旧风格累加，导致"视觉设定集未更新"的错觉。
  let vb = clean(board.visualBible || '');
  vb = vb.split('\n').filter((l) => !/^\s*画风：/.test(l)).join('\n').trim();
  if (/整体风格：/.test(vb)) {
    vb = vb.replace(/整体风格：[^。]*/, `整体风格：${zh}`);
  } else if (vb) {
    vb = `${vb}\n整体风格：${zh}`;
  } else {
    vb = `整体风格：${zh}`;
  }
  vb = `${vb}\n画风：${zh}`.trim();

  const seg = (board.segments || []).map((s) => ({
    ...s,
    imagePrompt: `${preEn}${clean(s.imagePrompt || '')}`.trim(),
    imagePromptZh: `${preZh}${clean(s.imagePromptZh || '')}`.trim(),
    videoPrompt: `${preEn}${clean(s.videoPrompt || '')}`.trim(),
    videoPromptZh: `${preZh}${clean(s.videoPromptZh || '')}`.trim(),
  }));
  return {
    ...board,
    visualBible: vb,
    globalPrompt: `${preEn}${clean(board.globalPrompt || '')}`.trim(),
    globalPromptZh: `${preZh}${clean(board.globalPromptZh || '')}`.trim(),
    globalVideoPrompt: `${preEn}${clean(board.globalVideoPrompt || '')}`.trim(),
    globalVideoPromptZh: `${preZh}${clean(board.globalVideoPromptZh || '')}`.trim(),
    segments: seg,
  };
}

/** 根据选中的画风，生成追加到系统提示词的约束 */
function styleInstruction(styleIds) {
  const styles = getStyles(styleIds);
  if (!styles.length) return '';
  const list = styles.map((s) => `- ${s.zh}（${s.en}）：${s.promptEn}`).join('\n');
  // 收集所有「非所选画风」的特征词，作为源头禁止清单——让 LLM 在生成阶段就避开其它风格，
  // 而不是生成后再靠 applyStylesToStoryboard 黑名单剥离兜底（双重保险，源头优先）。
  const forbidden = foreignStyleTokens(styleIds);
  const isNonPhotorealistic = styles.some((s) => /non-photorealistic/i.test(s.promptEn));
  let instr = `\n\n【指定画风（用户选择，必须贯穿全部分镜）】
本作品必须使用以下画风，所有分镜的 imagePrompt / videoPrompt / caption 都必须体现这些画风特征：
${list}

【禁止混入任何其它画风（最高优先级，选 A 绝不出现 B）】用户已明确指定上述画风，严禁在分镜提示词、全局提示词、视觉设定集中混入任何非上述画风的风格关键词，包括但不限于：${forbidden.slice(0, 80).join(' / ')}。所有风格描述必须完全以用户指定的画风为准，不得出现任何其它画风的特征词或质感描述。`;
  if (isNonPhotorealistic) {
    instr += `\n本次指定画风为非写实风格，必须在提示词中显式注明 non-photorealistic，严禁出现任何写实摄影质感（如 photorealistic / cinematic / film still / 35mm / 电影感 / 写实照片）与画风并存。`;
  }
  return instr;
}

// ── 逐段生成（batch=1）的「前情连贯」回传 ─────────────────────────────
// 每生成一段，把其「镜号/运镜/字幕摘要/景别」压缩进 continuityBrief，传给下一段 prompt，
// 保障相邻镜头的主角形象与场景连贯（避免人物突变、场景跳切）。保留最近 6 镜，聚焦相邻承接。
// 1.1.41：caption 截断从 36→80 字，增加运镜信息，brief 开头追加角色锁定行。
function summarizeSeg(seg) {
  if (!seg) return '';
  const shot = seg.shot ?? '';
  const cap = String(seg.caption || seg.captionZh || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const sz = seg.shotSize || '';
  const cam = seg.cameraMovement || '';
  return `第${shot}镜[${cam}]：${cap}${sz ? `（${sz}）` : ''}`;
}
function updateBrief(brief, segs) {
  const lines = brief ? brief.split('\n').filter(Boolean) : [];
  for (const s of segs || []) { const l = summarizeSeg(s); if (l) lines.push(l); }
  while (lines.length > 6) lines.shift();   // 4→6 镜
  return lines.join('\n');
}

export async function generateStoryboard(analysis, lyrics, segCount, agnes, jobId = null, styleIds = null) {
  const done = timeStep(jobId, 'storyboard', `agnes LLM 生成分镜（N=${segCount}）`);
  _subjectCache.delete(jobId); // 新任务：清除主角锁定缓存，让本次随机重新选角（跨任务不同、同任务一致）
  const MIN_PREFIX = Math.max(2, Math.floor(segCount * 0.6)); // imagePrompt 前缀至少需有 60% 不同
  // 分镜雪崩根因：1.1.3 之前把 23~27 段一次性发给 agnes-2.0-flash，模型在 150s 内无法返回，
  // 再叠加 chatCompletion(retries) × 外层(MAX_RETRY) 两层重跑全部批次 => 单步卡死 10+ 分钟仍失败。
  // 1.1.3 改为分批，但仍保留「外层重跑全部批次」——任一批失败整轮作废、下一轮又把全部段重来，依旧雪崩。
  // 1.1.4 方案：单批 ≤ STORYBOARD_BATCH 段、单批独立重试(BATCH_RETRIES 次)；
  //   —— 任一批彻底失败 => 仅用音乐特征兜底『该批』，并「熔断」剩余批次（立即兜底，不再空等），保证有界完成；
  //   —— 全局末尾统一做 forceUniqueCaptions（逐段差异化字幕）+ ensureZh（中文补全）+ attachCamera。
  const STORYBOARD_BATCH = 1;     // 1.1.10 起：逐段生成。单请求体积极小→超时/熔断概率最低；相邻连贯靠 continuityBrief 回传保障
  const BATCH_TIMEOUT = 300000;   // 1.1.12：agnes 当前负载下逐段仍要 50~126s，且偶发 180~220s 才返回。
                                 //   放大到 300s 让这些「慢但活着」的调用跑完；成功段本就 <130s，不受惩罚。
                                 //   1.1.20 起：单段默认重试提到 3 次；主生成失败的段先收集，全部波次跑完再做「抢救重试」，
                                 //   绝不降级 mock，但不再因单段瞬时抖动丢弃整轮已生成的其余段。
  const BATCH_RETRIES = Number(process.env.STORYBOARD_RETRIES) || 3;  // 1.1.20：单段默认重试 3 次（共 4 次尝试）。25 段并发生成下瞬时 socket hang up 几乎必然命中某段，3 次指数退避(6s/12s/24s)足以吸收绝大多数抖动；agnes 真挂才会在抢救后仍失败。可用 STORYBOARD_RETRIES 临时调高。
  const SALVAGE_RETRIES = Number(process.env.STORYBOARD_SALVAGE_RETRIES) || 4;  // 全部波次跑完后，对仍失败段再做的「抢救重试」次数（更高，因其余段已完成、负载下降）
  const BATCH_BASE_DELAY = 6000;  // 单段重试基准退避：给过载的 agnes 喘息，避免加剧限流
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SALVAGE_COOLDOWN_MS = Number(process.env.STORYBOARD_SALVAGE_COOLDOWN_MS) || 15000;  // 主生成全部波次跑完后、抢救重试前的冷却时间（让过载的 agnes 喘息）
  const STORYBOARD_CONCURRENCY = Number(process.env.STORYBOARD_CONCURRENCY) || 3; // 1.1.13：有界并发 3 路。batch 仍=1（每请求体极小、稳定），但 3 路并行把墙钟从 ~48min 压到十几分钟量级；实测 agnes 扛得住 2~3 路且不崩、不报 429。可用环境变量 STORYBOARD_CONCURRENCY=2 临时降并发。
  const batches = [];
  for (let s = 0; s < segCount; s += STORYBOARD_BATCH) batches.push([s, Math.min(s + STORYBOARD_BATCH, segCount)]);
  const totalWaves = Math.ceil(batches.length / STORYBOARD_CONCURRENCY);

  // ── 1.1.36：全局故事大纲（beat sheet）前置 —— 先规划弧线，再让逐镜 LLM 只细化本拍 ──
  const _allSegs = analysis?.segments || [];
  const _lyricAll = lyricLinesForSegs(lyrics, segCount, { segDuration: 10, vocalMask: buildVocalMask(_allSegs, segCount) });
  const _casts = assignCasts(_allSegs, analysis?.overall || {}, _lyricAll, segCount);
  const storyPlan = await buildStoryPlan(analysis, lyrics, segCount, _casts, agnes, jobId);
  log(jobId, 'info', 'storyboard', `故事大纲就绪：${storyPlan.beats.length} 拍，logline="${String(storyPlan.logline || '').slice(0, 36)}…"`);

  if (!agnes?.enabled) {
    throw new Error('Agnes 未启用（缺少 API Key / Base URL），无法生成分镜。请在设置中配置 Agnes 后重试。');
  }
  try {
    const segMap = new Map();     // bs -> segments[]，按镜号保序；主生成与抢救共用，避免失败段恢复后乱序
    let globals = null;
    let continuityBrief = ''; // 逐段生成时，已生成镜头的「镜号/字幕/景别」摘要，回传给下一段 prompt 保连贯
    const failedSegs = [];     // 主生成中经 BATCH_RETRIES 仍失败的段，待全部波次跑完后统一抢救
    let missingSegs = [];      // 抢救后仍失败、最终缺失的镜号（STORYBOARD_ALLOW_PARTIAL=1 时标注，绝不 mock 占位）
    // 单段生成器：同一波(wave)内的 CONCURRENCY 段并行请求 agnes（共享本波前情 continuityBrief）
    const genSeg = async (bs, be, basePct, continuityExtra, retriesOverride = null) => {
      const segLabel = `第 ${bs + 1}${be - bs === 1 ? ' 镜' : `-${be} 镜`}`;
      const tBatch = Date.now();
      const sysContent = STORYBOARD_SYSTEM_PROMPT + '\n' + CAMERA_LIBRARY_PROMPT + '\n' + MAPPING_RULES_TEXT + styleInstruction(styleIds);
      const userContent = buildUserPrompt(analysis, lyrics, segCount, continuityExtra, [bs, be], jobId, _casts, storyPlan);
      const mkMessages = (extra) => [
        { role: 'system', content: sysContent + (extra || '') },
        { role: 'user', content: userContent },
      ];
      try {
        const content = await withKeepAlive(
          jobId, basePct,
          `Agnes LLM 正在生成分镜（${segLabel}）…`,
          `模型=${agnes.chatModel}`,
          () => chatCompletion(
            agnes,
            mkMessages(''),
            { temperature: 0.8, json: true, jobId, retries: retriesOverride != null ? retriesOverride : BATCH_RETRIES, timeout: BATCH_TIMEOUT, baseDelayMs: BATCH_BASE_DELAY }
          )
        );
        const parsed = await repairAndParseStoryboard(content, agnes, jobId, segLabel, be - bs, mkMessages);
        log(jobId, 'info', 'storyboard', `✓ 批次 ${bs + 1}/${segCount}：${segLabel} 生成完成（耗时 ${Date.now() - tBatch}ms，获得 ${parsed?.segments?.length || 0} 段）`);
        return { ok: true, parsed };
      } catch (e) {
        log(jobId, 'warn', 'storyboard', `批次 ${bs + 1}/${segCount}：${segLabel} agnes 失败（${e.message}）`);
        return { ok: false, error: e };
      }
    };
    let waveNum = 0;
    for (let start = 0; start < batches.length; start += STORYBOARD_CONCURRENCY) {
      waveNum++;
      const waveBatches = batches.slice(start, start + STORYBOARD_CONCURRENCY);
      const firstBs = waveBatches[0][0];
      const lastBe = waveBatches[waveBatches.length - 1][1];
      const segRange = `第 ${firstBs + 1}~${lastBe} 镜`;
      const basePct = 74 + Math.floor(((waveNum - 1) / totalWaves) * 14);
      let continuityExtra = '';
      if (continuityBrief) {
        continuityExtra = `\n【前情连贯】以下是已生成的前序镜头，请严格保持主角形象（脸型/发型/发色/服装）、光线基调与叙事连贯，自然地承接上一镜，避免突兀跳切或角色突变：\n${continuityBrief}\n`;
      }
      // 1.1.41：每次都追加角色锁定行（即使首波 brief 为空），让 LLM 始终看到主角标准描述
      const _subj = resolveSubject(analysis?.overall, jobId);
      if (_subj.en) {
        continuityExtra += `\n【主角锁定（全程一致）】${_subj.en}。所有分镜中主角的脸型/发型/发色/服装必须与此描述完全一致，不得擅自更换服装颜色或款式。\n`;
      }
      setProgress(jobId, { percent: basePct, label: `Agnes LLM 生成分镜（波 ${waveNum}/${totalWaves}，并发 ${STORYBOARD_CONCURRENCY} 路，${segRange}）…`, detail: `模型=${agnes.chatModel}` });
      log(jobId, 'info', 'storyboard', `▶ 波 ${waveNum}/${totalWaves}：并发 ${STORYBOARD_CONCURRENCY} 路请求 agnes 生成${segRange}（共 ${segCount} 段，单批超时 ${(BATCH_TIMEOUT / 1000)}s）`);
      const results = await Promise.all(waveBatches.map(([bs, be]) => genSeg(bs, be, basePct, continuityExtra)));
      const waveSegObjs = [];
      for (let k = 0; k < results.length; k++) {
        const r = results[k];
        const [bs, be] = waveBatches[k];
        if (r.ok && r.parsed) {
          if (!globals) {
            globals = {
              visualBible: r.parsed.visualBible || '',
              globalPrompt: r.parsed.globalPrompt || '',
              globalPromptZh: r.parsed.globalPromptZh || '',
              globalVideoPrompt: r.parsed.globalVideoPrompt || '',
              globalVideoPromptZh: r.parsed.globalVideoPromptZh || '',
            };
          }
          const segs = r.parsed.segments || [];
          segMap.set(bs, segs);
          for (const seg of segs) waveSegObjs.push(seg);
        } else {
          // 不在此处直接中止：先收集失败段，等全部波次跑完再做「抢救重试」。
          // 坚决杜绝 mock 降级——失败段绝不以占位填充，仅在抢救仍失败时整轮抛出。
          failedSegs.push({ bs, be, error: r.error });
          log(jobId, 'warn', 'storyboard', `分镜第 ${bs + 1} 镜 主生成失败（已收集，待抢救）：${r.error?.message || '未知错误'}`);
        }
      }
      continuityBrief = updateBrief(continuityBrief, waveSegObjs);
    }
    // 全部波次跑完：对主生成失败的段做「抢救重试」（agnes 瞬时抖动常在并发压力下集中出现，
    // 其余段完成后负载下降，抢救成功率更高）。绝不 mock 降级——抢救仍失败才整轮抛出。
    if (failedSegs.length) {
      log(jobId, 'warn', 'storyboard', `分镜主生成有 ${failedSegs.length} 段失败，冷却 ${Math.round(SALVAGE_COOLDOWN_MS / 1000)}s 后启动抢救重试（不降级 mock）…`);
      await sleep(SALVAGE_COOLDOWN_MS);
      // 1.1.44：抢救改为 2 轮（轮间冷却 8s 再换一轮全新采样），单镜尝试机会翻倍；
      // 实测 agnes 瞬时退化常在数分钟内恢复，第二轮命中率显著更高（不 mock）。
      const SALVAGE_ROUNDS = Number(process.env.STORYBOARD_SALVAGE_ROUNDS) || 2;
      let pending = failedSegs;
      const stillFailed = [];
      for (let round = 1; round <= SALVAGE_ROUNDS && pending.length; round++) {
        log(jobId, 'warn', 'storyboard', `▶ 启动抢救重试（第 ${round}/${SALVAGE_ROUNDS} 轮）：对 ${pending.length} 段失败镜头再做 ${SALVAGE_RETRIES} 次高重试（不降级 mock）…`);
        const next = [];
        for (const f of pending) {
          const r = await genSeg(f.bs, f.be, 88, continuityBrief, SALVAGE_RETRIES);
          if (r.ok && r.parsed?.segments?.length) {
            if (!globals) {
              globals = {
                visualBible: r.parsed.visualBible || '',
                globalPrompt: r.parsed.globalPrompt || '',
                globalPromptZh: r.parsed.globalPromptZh || '',
                globalVideoPrompt: r.parsed.globalVideoPrompt || '',
                globalVideoPromptZh: r.parsed.globalVideoPromptZh || '',
              };
            }
            segMap.set(f.bs, r.parsed.segments);
            log(jobId, 'info', 'storyboard', `✓ 抢救成功：第 ${f.bs + 1} 镜 已恢复（第 ${round} 轮）`);
          } else {
            next.push(f);
          }
        }
        pending = next;
        if (pending.length && round < SALVAGE_ROUNDS) {
          log(jobId, 'warn', 'storyboard', `抢救第 ${round} 轮后仍有 ${pending.length} 段失败，冷却 8s 后进入下一轮…`);
          await sleep(8000);
        }
      }
      if (pending.length) {
        for (const f of pending) stillFailed.push({ bs: f.bs, error: f.error });
      }
      if (stillFailed.length) {
        const reasons = stillFailed
          .map((f) => `第 ${f.bs + 1} 镜：${f.error?.message || '未知错误'}`)
          .join('；');
        if (process.env.STORYBOARD_ALLOW_PARTIAL === '1') {
          log(jobId, 'warn', 'storyboard', `⚠ STORYBOARD_ALLOW_PARTIAL=1：返回已生成的 ${segCount - stillFailed.length}/${segCount} 段（真实内容、非 mock），缺失镜号=[${stillFailed.map((f) => f.bs + 1).join(', ')}]`);
          missingSegs = stillFailed.map((f) => f.bs + 1);
        } else {
          throw new Error(`分镜生成完成 ${segCount - stillFailed.length}/${segCount} 段，以下镜头仍生成失败（已尽力抢救、未降级占位）：${reasons}。可仅重试失败镜头后继续。`);
        }
      }
    }
    // 按镜号顺序汇总（主生成 + 抢救共用 segMap，保证失败段恢复后位置正确）
    const allSegments = [];
    for (const [bs, be] of batches) {
      const segs = segMap.get(bs);
      if (segs) for (const seg of segs) allSegments.push(seg);
    }
    // globals 在任一段成功时即赋值；此处若仍为 null 说明 segCount=0（边界情况）
    const merged = { ...(globals || {}), segments: allSegments };
    renumberSegments(merged); // 合并后按全局顺序重排 shot / timeRange
    merged.segments = forceUniqueCaptions(merged).segments;
    const fin = uniqueCounts(merged);
    const pimgFin = distinctImagePrefixes(merged);
    log(jobId, 'info', 'storyboard', `分镜结构校验：唯一 caption=${fin.caps}/${segCount}, 唯一 imagePrompt=${fin.imgs}/${segCount}, 不同前缀=${pimgFin}/${MIN_PREFIX}`);

    // ── 1.1.41 方案 A：角色描述注入 globalPrompt ──
    // LLM 常把角色信息放 visualBible 而非 globalPrompt，导致 t2i 无全局角色锁定。
    // 从 resolveSubject 提取已锁定的主角描述，注入 globalPrompt 前端。
    const _subjA = resolveSubject(analysis?.overall, jobId);
    if (_subjA.en && !/(?:featuring|consistent character|beautiful chinese)/i.test(merged.globalPrompt || '')) {
      const charLock = `${_subjA.en}, consistent character design across all shots`;
      merged.globalPrompt = `${charLock}, ${merged.globalPrompt || ''}`.trim();
      log(jobId, 'info', 'storyboard', `globalPrompt 已注入角色锁定（${_subjA.en.slice(0, 40)}…）`);
    }

    setProgress(jobId, { percent: 90, label: '生成中文提示词与逐段运镜…' });
    merged.segments = (await ensureZh(merged, agnes, jobId)).segments;
    const board = attachCast(attachCamera(merged, analysis, lyrics, segCount, jobId), analysis, lyrics, segCount, jobId);

    // ── 1.1.41 方案 B：修复 noCharacter/cast 矛盾 ──
    // attachCast 按配额标 noCharacter=true，但 LLM 可能已在 imagePrompt/caption 中写了人物。
    // 翻转为 false 以保留叙事所需人物（配额是软约束，叙事完整性优先）。
    let _flipped = 0;
    for (const s of board.segments) {
      if (s.noCharacter === true) {
        const ip = s.imagePrompt || '';
        const cap = s.caption || '';
        if (/\b(woman|man|girl|boy|she|her|his|主角|她)\b/i.test(ip) || /主角|她/.test(cap)) {
          s.noCharacter = false;
          s.cast = (s.cast || '').replace(/纯景\/?无人物.*$/, '').trim() || '主角独处';
          _flipped++;
        }
      }
    }
    if (_flipped) log(jobId, 'info', 'storyboard', `noCharacter 矛盾修正：${_flipped} 镜从纯景翻转为保留人物（imagePrompt 含角色描述）`);

    // ── 1.1.41 方案 C：imagePrompt 服装一致后处理 ──
    // 从 resolveSubject 提取标准服装，替换各镜 imagePrompt 中的冲突服装描述。
    // 1.1.41 补充：resolveSubject 某些 mood 组合的候选无服装词（如 "in gentle twilight"），
    // 此时从 visualBible 的【主角服装】提取中文服装描述做中英映射兜底。
    const _zhClothingMap = {
      '亚麻长裙': 'linen dress', '亚麻': 'linen', '米白色': 'off-white', '白色': 'white',
      '长裙': 'long dress', '连衣裙': 'dress', '丝绸': 'silk', '丝质': 'silk', '丝': 'silk',
      '黑色': 'black', '深蓝': 'dark blue', '深色': 'dark', '灰色': 'grey', '浅色': 'light',
      '风衣': 'trench coat', '针织': 'knitted', '开衫': 'cardigan', '旗袍': 'qipao',
      '外套': 'coat', '衬衣': 'shirt', '衬衫': 'shirt', '西服': 'suit',
    };
    let _canonicalClothing = '';
    if (_subjA.en) {
      const _clothingMatch = _subjA.en.match(/(?:wearing|in)\s+(?:a\s+)?([^,]+?(?:dress|gown|outfit|suit|shirt|coat|qipao)[^,]*)/i);
      if (_clothingMatch) _canonicalClothing = _clothingMatch[1].trim();
    }
    if (!_canonicalClothing) {
      // 兜底：从 visualBible【主角服装】提取中文并映射为英文
      const _vb = merged.visualBible || '';
      const _vbM = _vb.match(/【主角服装】([^\n【]+)/);
      if (_vbM) {
        let _zhC = _vbM[1].trim();
        let _colorParts = [];
        let _materialParts = [];
        for (const [zh, en] of Object.entries(_zhClothingMap)) {
          if (_zhC.includes(zh)) {
            // 颜色词放前面、材质词放后面，保证英文词序（如 "off-white linen dress"）
            if (/off-white|white|black|dark|grey|light|cream|blue/i.test(en)) _colorParts.push(en);
            else _materialParts.push(en);
            _zhC = _zhC.replace(zh, ' ');
          }
        }
        const _enParts = [..._colorParts, ..._materialParts];
        if (_enParts.length) {
          _canonicalClothing = _enParts.join(' ').trim();
          // 颜色词：视觉Bible 里"米白/白/黑"等颜色词在映射中已处理；若仍有残余颜色词，补兜底
          if (!/white|black|grey|blue|off-white|cream|linen|silk|dark/i.test(_canonicalClothing)) {
            _canonicalClothing = `off-white ${_canonicalClothing}`;
          }
        }
      }
    }
    if (_canonicalClothing) {
      // 匹配 imagePrompt 中的冲突服装词（颜色+材质+dress/gown）
      const _clothingRe = /(?:deep\s+blue|dark\s+blue|grey-blue|grey|gray|dark\s+navy|navy|black|white|dark|cream-colored|off-white|deep\s+red|dark\s+red|burgundy|emerald|sapphire)\s+(?:elegant\s+|simple\s+|long\s+)?(?:silk|velvet|linen|cotton|chiffon|satin)?\s*(?:long\s+)?(?:dress|gown|slip\s+dress)/gi;
      let _replaced = 0;
      for (const s of board.segments) {
        if (s.noCharacter) continue;
        const orig = s.imagePrompt || '';
        s.imagePrompt = orig.replace(_clothingRe, _canonicalClothing);
        if (s.imagePrompt !== orig) _replaced++;
      }
      if (_replaced) log(jobId, 'info', 'storyboard', `服装一致性后处理：${_replaced} 镜服装词替换为标准款（${_canonicalClothing.slice(0, 30)}…）`);
      // 方案 C 联动：若 characterLock 无服装词，把标准服装并入 characterLock 与 globalPrompt
      if (!/dress|gown|coat|suit|shirt|qipao/i.test(_subjA.en || '')) {
        const _cl = _subjA.en || '';
        if (_cl) {
          const _clAug = `${_cl}, wearing ${_canonicalClothing}`;
          board.characterLock = _clAug;
          // 全局提示词已含 _subjA.en 前缀（方案A注入），原位替换为带服装的版本
          if (board.globalPrompt && board.globalPrompt.includes(_cl)) {
            board.globalPrompt = board.globalPrompt.replace(_cl, _clAug);
          }
          log(jobId, 'info', 'storyboard', `characterLock 已补充标准服装：wearing ${_canonicalClothing}`);
        }
      }
    }

    if (missingSegs.length) { board.partial = true; board.missingSegments = missingSegs; }
    const cam = new Set(board.segments.map((s) => s.cameraMovement)).size;
    log(jobId, 'info', 'storyboard', `分镜生成完成：${board.segments.length} 段，运镜种类 ${cam} 种`);
    board.storyPlan = storyPlan; // 1.1.36：挂上全局故事大纲，随 applyStyles 展开进 report，便于查看全片弧线
    // 1.1.41 方案 F：把角色锁定描述挂到 board 上，供 t2i 使用。
    // 若方案 C 已补充服装，则保留带服装的版本（不覆盖）。
    if (!board.characterLock) board.characterLock = _subjA.en || '';
    done(true, `生成 ${board.segments.length} 段（中文脚本 + 中英双语提示词）`);
    return board;
  } catch (e) {
    log(jobId, 'error', 'storyboard', `agnes 分镜生成失败：${e.message}`);
    throw e;
  }
}
