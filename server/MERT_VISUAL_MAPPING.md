# MERT 音频特征 → 视觉提示词 转译模板

把 `mert_infer.py` 输出的音频分析 JSON，自动映射为分镜所需的视觉指令（景别 / 运镜 / 转场 / 色调 / 质感）。
代码实现见 `server/src/services/mapping.js`（`MAPPING_RULES_TEXT` 写进 LLM 系统提示词，`buildMappingContext()` 是 JSON 解析模板，把 MERT 数值直接填充为逐段视觉指令）。

---

## 1. MERT 输出 JSON 结构（新增字段已标注 ★）

```json
{
  "overall": {
    "genre": "Ambient",
    "mood": "dreamy",
    "moodZh": "梦幻",
    "tempoBpm": 72.0,
    "energy": 0.21,
    "loudness": -24.5,            // ★ 全曲近似 LUFS（RMS 标定，非 BS.1770 真值）
    "warmth": 0.62,               // ★ 听觉温度（0=最冷、1=最暖），由音色明度+能量独立估算，与 mood 解耦
    "style": "oil painting, impressionist brushstrokes, warm light",
    "colorPalette": "teal & gold",
    "suggestedSubject": "a slender silver-haired girl",
    "mertMean": 0.0021,
    "mertStd": 0.031
  },
  "segments": [
    {
      "index": 0,
      "startTime": 0.0,
      "energy": 0.18,
      "brightness": 0.52,
      "motion": "slow steady pan, gentle drift",
      "mood": "dreamy",
      "moodZh": "梦幻",
      "loudness": -25.1,          // ★ 该段近似 LUFS
      "tempoBpm": 70.0,           // ★ 该段节拍
      "energyDelta": { "dB": 0.0, "trend": "flat" }, // ★ 相邻段 RMS 差值
      "note": "segment 1: dreamy moment, ...",
      "mertMean": 0.0021,
      "mertStd": 0.031
    }
  ]
}
```

> **响度标定说明**：`loudness = 10·log10(rms²) + 6`（单位 LUFS 近似）。典型流行/电子曲 RMS≈0.15~0.25 → -10~-16 LUFS；轻柔长笛 RMS≈0.03 → ≈-24 LUFS。仅用于下方阈值映射，非专业响度测量。

---

## 2. 硬性映射表（MERT 维度 → 视觉维度）

| 音频维度 | 视觉维度 | 映射规则 |
|---|---|---|
| **风格 style** | 材质/质感 | oil painting→柔光笔触；anime→清晰线稿鲜艳；synthwave/cyberpunk→霓虹体积雾八分渲染；cinematic 3d→电影感体积光胶片颗粒 |
| **配色 colorPalette** | 色相/色调 | 由**独立 warmth 轴**驱动：warmth≥0.6→warm orange & cream；≥0.45→teal & gold；≥0.35→deep purple & cyan；<0.35→monochrome blue。**全局统一主色，单段叠加强调色** |
| **听觉温度 warmth** | 冷暖基调 | warmth≥0.45 视为暖（即便 mood=mysterious 也走暖区）；<0.35 为冷。**温暖乐器（萨克斯/大提琴/原声）一律暖色夜色怀旧，绝不用太空/宇航员/单色蓝** |
| **意境 mood** | 画面内容/情绪 | dreamy→飘浮柔光粒子；energetic→爆发光柱粒子飞散；melancholic→雨夜空荡孤独；mysterious→迷雾阴影镜影；uplifting→阳光穿叶花海；warm→暖光亲密 |
| **主体 suggestedSubject** | 主角意象 | 温度感知：暖系→爵士吧人影/暖光狐狸/暖光人形（**神秘不再用宇航员**）；冷系→宇航员/纸灯笼儿童/银发少女 |
| **响度 loudness (LUFS)** | **景别 + 景深** | ≥-10→大特写/特写，浅景深 f/1.2；-18~-10→中景/中近景 f/2.8；-25~-18→全景/远景 f/8；<-25→大远景/极远景 f/16 |
| **节奏 tempo (BPM)** | **运镜** | ≥140→手持/快速摇镜/震动；110~140→轨道/环绕；80~110→缓慢横移/升降；<80→静止/极慢推近 |
| **能量变化 energyDelta (dB)** | **转场** | ≥+3dB→快速闪白/冲击波；+1~3dB→溶解/叠化；±1dB→直切；≤-1dB→缓入淡黑/慢速溶解 |

**冲突优先级**：响度(景深) > 配色(由 warmth) > 意境 > 风格。

---

### 独立冷暖轴（warmth）说明

旧逻辑用 `mood` 判定冷暖：`mysterious` 被机械绑成冷色，导致**温暖萨克斯**被推成「单色蓝 + 流浪宇航员」的冰冷宇宙。
现改为 `warmth` 由音频本身估算（音色明度 brightness 为主、能量为辅，**与 mood 解耦**）：

```
warmth = clip(1.0 - brightness*1.05 + (energy - 0.5)*0.1, 0, 1)
is_warm = warmth >= 0.45
```

- 醇厚乐器（萨克斯 centroid≈0.4~0.5 归一）→ warmth≈0.47~0.52 → **暖**（teal & gold / 爵士吧人影）
- 清亮乐器（长笛 centroid≈0.6~0.8）→ warmth<0.35 → **冷**（monochrome blue / 宇航员）

LLM 系统提示词同步加入「乐器/音色温度锚点」：醇厚温暖乐器无论 mood 标签如何，一律暖色夜色怀旧，禁止太空/宇航员/赛博朋克冷硬主体。

---

## 3. JSON 解析模板（自动填充后的用户输入片段）

`buildMappingContext(analysis, segCount)` 把上面的 MERT JSON 直接渲染成如下文本，注入 LLM 用户提示词（无需手工填）：

```
【全局视觉基调（由 MERT 自动映射）】
- 美术风格：oil painting, impressionist brushstrokes, warm light
- 主色调：teal & gold
- 意境基调：dreamy（梦幻）
- 平均响度：-24.5 LUFS → 基准景别：大远景/极远景（Extreme Long / Wide Shot）
- 平均节奏：72.0 BPM → 基准运镜：静止固定/极慢推近（static / slow push-in）

【逐段视觉转译指令（MERT 数值 → 视觉，必须逐段落实）】
分段1 [0s]: 意境=dreamy（梦幻）| 响度=-25.1 LUFS → 景别=大远景/极远景（infinite depth of field, f/16, hyperfocal, every detail sharp）| 节奏=70.0 BPM → 运镜=静止固定/极慢推近（static / slow push-in）| 能量变化=首段 → 转场=直切（hard cut）| 相对能量=0.86 | 色彩温度=cool-warm dreamy | 情绪元素=floating particles, soft glow, drifting upward
分段2 [10s]: 意境=warm（温暖）| 响度=-22.3 LUFS → 景别=全景/远景（deep depth of field, f/8, foreground and background both sharp）| 节奏=84.0 BPM → 运镜=缓慢横移/升降（slow pan / pedestal）| 能量变化=+2.1dB(rise) → 转场=溶解/叠化（dissolve / crossfade）| 相对能量=1.12 | 色彩温度=warm amber | 情绪元素=warm light, intimacy, campfire glow
```

LLM 据此在每段 `imagePrompt / videoPrompt` 中落实景别/运镜/转场，并填写 `shotSize` 与 `transition` 字段。

---

## 4. 端到端示例（悠扬长笛 → 视觉）

MERT 输出：`genre=Ambient, mood=dreamy, loudness≈-24 LUFS, tempo≈72 BPM, energyDelta 平缓`
→ 自动映射：`景别=大远景(f/16)`，`运镜=静止/极慢推近`，`转场=直切`，`色调=teal & gold`，`风格=oil painting 暖光`
→ 视觉提示词（LLM 生成示例）：
`a slender silver-haired girl standing in a vast misty meadow at dawn, extreme long shot with infinite depth of field f/16, oil painting impressionist brushstrokes warm light, teal and gold color palette, static slow push-in camera, dreamy floating particles and soft glow, tranquil horizon, 8k, detailed`

> 对比修复前：旧逻辑用单一能量标量 `gi` 索引数组，长笛也曾被抽中「cyberpunk + 纸灯笼儿童 + 单色蓝」。现改为按语义分别映射，柔和曲子只会落进油画/手绘/柔光 + 暖色系。
