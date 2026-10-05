#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MERT-v1-95M 本地音频分析。
用法: python mert_infer.py <audio_path> <seg_seconds> <seg_count>
输出: 标准 JSON 到 stdout
  {
    "overall": { genre, mood, tempoBpm, energy, loudness, warmth, style, colorPalette, suggestedSubject, mertMean, mertStd },
    "segments": [ { index, startTime, energy, brightness, motion, mood, loudness, tempoBpm, energyDelta, note, mertMean, mertStd } ]
  }
依赖: torch, transformers, librosa, soundfile, numpy

注：loudness 为基于 RMS 的 LUFS 近似值（非 ITU-R BS.1770 真值，仅用于视觉映射阈值判断），
energyDelta 为相邻段 RMS 的 dB 差值（能量变化），tempoBpm 为逐段节拍估计。
"""
import sys, json, os, math, warnings
import numpy as np
import librosa
import torch

# 强制单线程前向：彻底规避 Windows 上 MKL/OpenMP 多线程初始化偶发的
# 0xC0000005（STATUS_ACCESS_VIOLATION）原生崩溃。CPU 推理略慢，但稳定。
try:
    torch.set_num_threads(1)
except Exception:
    pass

# 抑制 librosa.beat.tempo 的弃用警告（该别名在 librosa 1.0 才移除，当前功能正常）
warnings.filterwarnings('ignore', message='.*beat\\.tempo.*')

# 强制 stdout/stderr 以 UTF-8 输出：Windows 下管道默认用 GBK(cp936) 编码，
# 而 Node 以 UTF-8 读取子进程输出，中文会全部变成乱码。这里双保险。
try:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def emit(percent, label, done=None, total=None):
    """向 stderr 打进度标记，Node 端解析后转成日志与百分比进度。
    结果 JSON 仍从 stdout 最后一行输出，二者互不干扰。"""
    obj = {"percent": round(float(percent), 1), "label": label}
    if done is not None:
        obj["done"] = done
    if total is not None:
        obj["total"] = total
    try:
        print("PROGRESS " + json.dumps(obj, ensure_ascii=False), file=sys.stderr, flush=True)
    except Exception:
        pass

MODEL_PATH = os.environ.get("MERT_MODEL_PATH", r"D:/TEST/music-mert/models/MERT-v1-95M")


def estimate_lufs(rms_mean):
    """基于 RMS 均值的 LUFS 近似值（仅用于视觉映射阈值判断，非 ITU-R BS.1770 真值）。
    标定：典型流行/电子曲 RMS≈0.15~0.25 落在 -10~-16 LUFS；轻柔长笛 RMS≈0.03 落在 -24 LUFS 附近。"""
    if rms_mean is None or rms_mean <= 0:
        return -70.0
    return round(10.0 * math.log10(rms_mean * rms_mean + 1e-12) + 6.0, 1)

MOODS = ["dreamy", "energetic", "melancholic", "uplifting", "mysterious", "warm"]
GENRES = ["Lo-fi Hip-Hop", "Cinematic Orchestral", "Synthwave", "Acoustic Pop", "Future Bass", "Ambient"]
SUBJECTS = ["a slender silver-haired girl", "a small glowing fox spirit", "a wandering astronaut", "a paper lantern child", "a neon samurai"]
PALETTES = ["teal & gold", "deep purple & cyan", "warm orange & cream", "monochrome blue", "rose & indigo"]
STYLES = ["cinematic 3d render, soft volumetric light, film grain",
          "anime key visual, vibrant colors, crisp linework",
          "oil painting, impressionist brushstrokes, warm light",
          "cyberpunk concept art, neon reflections, detailed",
          "hand-drawn storybook, gentle pastel tones"]


def load_model():
    from transformers import AutoModel, AutoFeatureExtractor
    fe = AutoFeatureExtractor.from_pretrained(MODEL_PATH, trust_remote_code=True)
    model = AutoModel.from_pretrained(MODEL_PATH, trust_remote_code=True)
    model.eval()
    return model, fe


def mert_embed(model, fe, y, sr):
    # 取单声道并 resample 到 24k
    if y.ndim > 1:
        y = y.mean(axis=0)
    if sr != 24000:
        y = librosa.resample(y, orig_sr=sr, target_sr=24000)
    inputs = fe(y, sampling_rate=24000, return_tensors="pt")
    with torch.no_grad():
        out = model(**inputs, output_hidden_states=True)
    hs = out.hidden_states[-1]          # (1, time, hidden)
    emb = hs.squeeze(0).mean(dim=0).cpu().numpy()  # (hidden,)
    return emb


def main():
    audio_path = sys.argv[1]
    seg_seconds = float(sys.argv[2])
    seg_count = int(sys.argv[3])

    emit(1, "加载 MERT 模型（首次较慢）…")
    model, fe = load_model()
    emit(6, "模型已加载，读取音频…")
    y, sr = librosa.load(audio_path, sr=24000, mono=True)
    total = len(y) / sr

    # 全局特征
    emit(9, "提取全曲特征（节拍/能量/音色）…")
    tempo = float(librosa.beat.tempo(y=y, sr=sr)[0])
    rms = librosa.feature.rms(y=y)[0]
    cent = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    global_energy = float(np.mean(rms))
    global_bright = float(np.mean(cent)) / 4000.0  # 粗略归一化
    emit(12, f"全曲特征完成（BPM≈{tempo:.0f}）")

    # === MERT 整曲一次深度分析：分块推理后聚合为单个整曲 embedding ===
    # 整曲一次性过 transformer 在 CPU 上是 O(n^2) 复杂度（实测 5.6 分钟曲约 10 分钟），
    # 故分块（每块 30s）推理、逐块上报进度，避免长音频静默与极慢；
    # 最后平均各块 embedding 得到整曲向量。输出契约不变：所有分镜段共用这一个整曲
    # mertMean/mertStd（仍满足"MERT 只对整曲分析，不按分镜切片"的要求）。
    CHUNK = 20  # 单块秒数，限制 transformer 序列长度，规避 O(n^2) 过慢/静默
              # 同时让单次前向更短（总 CPU 开销 ∝ 块长），降低单块阻塞时长
    n_chunks = max(1, int(np.ceil(total / CHUNK)))
    emit(15, f"对整曲运行 MERT 深度分析（约 {total:.0f}s，分 {n_chunks} 块，请稍候）…")
    emb_list = []
    for c in range(n_chunks):
        cs = int(c * CHUNK * sr)
        ce = min(len(y), int((c + 1) * CHUNK * sr))
        chunk_y = y[cs:ce]
        if len(chunk_y) < int(sr * 1):
            chunk_y = y  # 异常短块兜底为全曲
        emb = mert_embed(model, fe, chunk_y, 24000)
        emb_list.append(emb)
        pct = 15 + (c + 1) / n_chunks * 43   # 15% → 58% 均分各块
        emit(pct, f"MERT 整曲分析（块 {c + 1}/{n_chunks}）", done=c + 1, total=n_chunks)
    overall_emb = np.mean(np.stack(emb_list), axis=0)
    emb_mean = float(np.mean(overall_emb))
    emb_std = float(np.std(overall_emb))
    emit(60, "MERT 整曲分析完成，逐段提取声学特征…")

    # 全曲裁剪后的能量/明度（与逐段 e_norm 同量纲，用于计算相对能量）
    overall_energy = float(np.clip(global_energy * 3, 0, 1))
    overall_bright = float(np.clip(global_bright, 0, 1))
    global_loudness = estimate_lufs(global_energy)  # 全曲近似 LUFS

    # 逐段仅提取轻量声学特征（librosa，快速；MERT 深度特征全段共用整曲结果）
    raw = []
    for i in range(seg_count):
        start = int(i * seg_seconds * sr)
        end = min(len(y), int((i + 1) * seg_seconds * sr))
        seg_y = y[start:end]
        if len(seg_y) < sr * 0.5:
            seg_y = y  # 末尾过短则用全曲兜底
        s_rms = librosa.feature.rms(y=seg_y)[0]
        s_cent = librosa.feature.spectral_centroid(y=seg_y, sr=sr)[0]
        energy = float(np.mean(s_rms))
        bright = float(np.mean(s_cent)) / 4000.0
        # 逐段节拍（短音频 beat.tempo 较快；失败则回落全局 tempo）
        try:
            seg_tempo = float(librosa.beat.tempo(y=seg_y, sr=sr)[0])
        except Exception:
            seg_tempo = float(tempo)
        raw.append({
            "index": i,
            "energy_raw": energy,
            "bright": float(np.clip(bright, 0, 1)),
            "tempo": seg_tempo,
            "loudness": estimate_lufs(energy),
        })
        # 逐段进度：60% → 95%（librosa 很快，主要耗时已在整曲 MERT）
        pct = 60 + (i + 1) / seg_count * 35
        emit(pct, f"逐段声学特征 {i + 1}/{seg_count} 段", done=i + 1, total=seg_count)

    # 段间变化：用逐段能量归一值的离散度体现（不再依赖逐段 MERT embedding）
    energy_norms = [float(np.clip(r["energy_raw"] * 3, 0, 1)) for r in raw]
    variation = float(np.std(energy_norms)) if len(energy_norms) > 1 else 0.0

    # 第二遍：用 EMA 平滑连续信号，映射为更连续、电影化、低抖动的标签
    # 情绪按"唤醒度"单调映射（低=忧郁/梦幻，高= energetic/鼓舞），避免相邻段乱跳
    MOOD_BY_AROUSAL = ["melancholic", "dreamy", "mysterious", "warm", "uplifting", "energetic"]
    MOOD_ZH = {
        "melancholic": "忧郁", "dreamy": "梦幻", "mysterious": "神秘",
        "warm": "温暖", "uplifting": "昂扬", "energetic": "亢奋",
    }
    # 运镜按"相对能量"分级（相对全曲更响=更动感），5 档电影化词汇
    def motion_for(ratio):
        if ratio >= 1.25:
            return "dynamic handheld camera, rapid whip pans, jittery motion"
        if ratio >= 1.05:
            return "active push-in and tracking, flowing motion"
        if ratio >= 0.88:
            return "slow steady pan, gentle drift"
        if ratio >= 0.70:
            return "near-static, slow floating dolly"
        return "static frame, barely perceptible motion"

    segments = []
    sc_smooth = 0.0
    ratio_smooth = 1.0
    alpha = 0.5  # EMA 平滑系数

    # 段间能量变化（相邻段 RMS 的 dB 差值 → 转场强度）
    energy_deltas = []
    prev_e = None
    for r in raw:
        e = r["energy_raw"]
        if prev_e is None or prev_e <= 0 or e <= 0:
            energy_deltas.append({"dB": 0.0, "trend": "flat"})
        else:
            db = 10.0 * math.log10(e / prev_e)
            if db >= 3:
                trend = "sharp_rise"
            elif db >= 1:
                trend = "rise"
            elif db <= -1:
                trend = "fall"
            else:
                trend = "flat"
            energy_deltas.append({"dB": round(db, 2), "trend": trend})
        prev_e = e

    for idx, r in enumerate(raw):
        e_norm = float(np.clip(r["energy_raw"] * 3, 0, 1))
        b_norm = r["bright"]
        # 连续唤醒度分数：能量为主、明度为辅（归一 0..1）
        sc = 0.6 * e_norm + 0.4 * b_norm
        sc_smooth = alpha * sc + (1 - alpha) * sc_smooth
        # 相对能量（与全曲对比，使用同量纲的裁剪值），平滑后分级
        ratio = (e_norm / overall_energy) if overall_energy > 0 else 1.0
        ratio_smooth = alpha * ratio + (1 - alpha) * ratio_smooth
        mood_idx = min(5, max(0, int(round(sc_smooth * 6 - 0.5))))
        mood = MOOD_BY_AROUSAL[mood_idx]
        motion = motion_for(ratio_smooth)
        i = r["index"]
        delta = energy_deltas[idx]
        segments.append({
            "index": i,
            "startTime": round(i * seg_seconds, 2),
            "energy": round(e_norm, 3),
            "brightness": round(b_norm, 3),
            "motion": motion,
            "mood": mood,
            "moodZh": MOOD_ZH[mood],
            "loudness": r["loudness"],
            "tempoBpm": round(r["tempo"], 1),
            "energyDelta": delta,
            "note": f"segment {i + 1}: {mood} moment, relative energy {ratio_smooth:.2f}, loudness {r['loudness']} LUFS, tempo {r['tempo']:.0f} BPM, energy delta {delta['dB']:+}dB ({delta['trend']})",
            "mertMean": round(emb_mean, 4),
            "mertStd": round(emb_std, 4),
        })

    overall_mood_idx = min(5, max(0, int(round((0.6 * overall_energy + 0.4 * overall_bright) * 6 - 0.5))))
    mood = MOOD_BY_AROUSAL[overall_mood_idx]
    # === 视觉风格/配色/主体：改为按"音乐情绪特征"语义映射，而非单一 gi 索引 ===
    # 旧逻辑用 gi = energy*4 + variation*20 同时索引 genre/style/palette/subject 四个
    # 语义独立的数组，且数组未按强度排序，导致悠扬柔和的曲子也会落到
    # "cyberpunk + 纸灯笼儿童 + 单色蓝"(gi=3) 这种与音乐气质完全不符的风格。
    # 现按：能量(强度)→柔和/动感风格与流派；情绪冷暖→配色；情绪→主体，分别映射。
    # 注意：calm/vivid 以"能量"为准（最直白的静/动信号），不再依赖推导出的 mood，
    # 避免强劲曲子被误判成 warm 而错配柔光风格。
    intensity = overall_energy  # 已在 [0,1]，高=动感
    is_calm = intensity < 0.6

    # === 独立冷暖轴（warmth）：与 mood 解耦 ===
    # 以音色明度(brightness)为主、能量为辅估算"听觉温度" warmth∈[0,1]（1=最暖）。
    # 低明度(醇厚：萨克斯/大提琴/原声)→暖；高明度(清亮：长笛/合成器主音)→冷。
    # 旧逻辑用 mood 判定冷暖：mysterious 被机械绑成冷色，导致温暖萨克斯被推成
    # "单色蓝 + 流浪宇航员"的冰冷宇宙，与音乐气质完全相反。
    # 现改为由音频本身的明度/能量决定冷暖，mysterious 只是"情绪"不再决定"温度"。
    warmth = float(np.clip(1.0 - overall_bright * 1.05 + (intensity - 0.5) * 0.1, 0, 1))
    is_warm = warmth >= 0.45

    # 风格/流派：柔和曲→油画/手绘/柔光；动感曲→anime/cyberpunk/synthwave。
    # 列表按"由弱到强"排序，intensity 越高取越靠后的元素。
    # 默认电影感（cinematic）：全系列以电影质感为基础，再按强度叠加其它风格元素。
    # 低强度→电影感+油画/手绘柔光；中→纯电影感体积光；高→电影感+赛博/霓虹。
    # 注意：所有风格描述禁止包含"oil painting / impressionist / brushstroke"等油画词汇，
    # 否则 Agnes T2I 模型会倾向于输出带厚重笔触/色斑/油画肌理的画面，破坏其他画风。
    # 柔和曲风格：按冷暖轴拆分，避免「冷配色 + 暖风格」自相矛盾（如 monochrome blue 配 warm glow）。
    soft_styles_warm = [
        "cinematic 3d render, anamorphic lens, soft volumetric light, warm glow, film grain, filmic color grading",
        "cinematic soft focus, gentle volumetric light, warm atmospheric glow, shallow depth of field, filmic color grading",
        "cinematic hand-drawn storybook aesthetic, gentle warm pastel tones, filmic soft light",
    ]
    soft_styles_cold = [
        "cinematic 3d render, anamorphic lens, soft volumetric light, cool tone, film grain, filmic color grading",
        "cinematic soft focus, gentle volumetric light, cool muted atmosphere, shallow depth of field, filmic color grading",
        "cinematic hand-drawn storybook aesthetic, gentle cool pastel tones, filmic soft light",
    ]
    vivid_styles = [
        "cinematic key visual, rich saturated colors, crisp linework, anamorphic lens flare, film grain",
        "cinematic synthwave, neon retro futurism, vivid color, filmic lighting, 35mm aesthetic",
        "cinematic cyberpunk, neon reflections, volumetric fog, anamorphic bokeh, filmic color grading",
    ]
    if is_calm:
        style_list = soft_styles_warm if is_warm else soft_styles_cold
    else:
        style_list = vivid_styles
    style = style_list[min(len(style_list) - 1, int(round(intensity * (len(style_list) - 1))))]

    soft_genres = ["Ambient", "Cinematic Orchestral", "Lo-fi Hip-Hop"]
    vivid_genres = ["Acoustic Pop", "Synthwave", "Future Bass"]
    genre_list = soft_genres if is_calm else vivid_genres
    genre = genre_list[min(len(genre_list) - 1, int(round(intensity * (len(genre_list) - 1))))]

    # 配色：由独立 warmth 轴驱动（不再依赖 mood 标签）。
    # 暖→橙奶/青金；中性→深紫青；冷→单色蓝（仅极冷）。
    # 阈值经调校：典型醇厚乐器(萨克斯 centroid≈0.4-0.5 归一)落在暖区，
    # 清亮乐器(长笛≈0.6-0.8)落在冷区，长笛与萨克斯不再混淆。
    if warmth >= 0.6:
        palette = "warm orange & cream"
    elif warmth >= 0.45:
        palette = "teal & gold"
    elif warmth >= 0.35:
        palette = "deep purple & cyan"
    else:
        palette = "monochrome blue"

    # 主体：温度感知。暖系→温暖主体；冷系→冷峻主体。
    # ★ 所有人类角色默认为中国帅气男性或中国美丽女性（根据情绪分配性别，按温度决定场景氛围）。
    #     禁止使用中性 "East Asian figure" 等模糊描述。
    def choose_subject(m, warm, intr):
        # 注意：以下描述只写外貌、服装、发型、肤色、姿态/气场（bearing/presence/stance），
        # ★绝不能写死任何固定面部表情★（如 gentle smile / wistful / serene expression /
        # intense gaze / bright smile / radiant / confident expression 等）。
        # 表情必须由逐镜头情绪驱动，否则图生视频时锁死的表情会扭曲成怪异表情。
        # 注意：以下描述只写「人物本身」——外貌、服装、发色、五官、体型、气质/气场（bearing/presence/stance）、
        # 以及角色统一的「关键光/基调光」（如 warm amber lamplight / golden glow / cool silver tones / cinematic noir）。
        # ★绝不能把某一固定地点/场景写进主体描述★（如 in a jazz bar / by a rain-streaked window /
        # on a rooftop / in a dark alley / urban night scene 等），否则该地点会被拼进全局提示词与每一段
        # imagePrompt，导致主角被锁死在同一场景，与「画面随歌词/情绪在各地迁移」的初衷冲突。
        # 具体场景由逐段 storyboard（歌词+segMood）决定，人物随场景迁移即可。
        subj_male_warm = {
            "melancholic": "a handsome Chinese man, dark hair, sharp jawline, warm amber key light, mysterious atmosphere, contemplative bearing",
            "mysterious": "a handsome Chinese man, dark hair, defined features, warm amber lamplight, cinematic noir, smoky atmosphere",
            "dreamy": "a handsome Chinese man with windswept black hair, golden sunset glow, soft focus, dreamlike atmosphere",
            "warm": "a handsome Chinese man, dark hair, relaxed bearing, golden lamplight, soft bokeh background",
            "uplifting": "a handsome Chinese man in warm morning sunlight, athletic build, dark hair, upright posture",
            "energetic": "a handsome Chinese man in radiant golden light, dynamic motion, sharp features, energetic, dark hair",
        }
        subj_female_warm = {
            "melancholic": "a beautiful Chinese woman, long black hair, soft amber glow, contemplative bearing, cinematic warmth",
            "mysterious": "a beautiful Chinese woman, warm amber lamplight, long black hair, red lips, cinematic noir",
            "dreamy": "a beautiful Chinese woman wrapped in flowing silk, warm golden light, floating petals, long black hair, ethereal atmosphere",
            "warm": "a beautiful Chinese woman bathed in golden lamplight, long flowing black hair, cinematic warmth, elegant bearing",
            "uplifting": "a beautiful Chinese woman in warm radiant sunlight, long black hair, elegant posture, graceful stance",
            "energetic": "a beautiful Chinese woman in dramatic warm light, wind in her long hair, powerful presence, cinematic energy",
        }
        subj_male_cold = {
            "melancholic": "a handsome Chinese man, dark hair, soft cold light, contemplative bearing, cinematic solitude",
            "mysterious": "a handsome Chinese man wearing a dark coat, deep shadows, sharp features, cinematic noir",
            "dreamy": "a handsome Chinese man, cool silver tones, flowing dark hair, ethereal atmosphere",
            "warm": "a handsome Chinese man in soft twilight, cool blue tones, contemplative bearing, defined features",
            "uplifting": "a handsome Chinese man in crisp morning light, upright posture, cool tone, cinematic",
            "energetic": "a handsome Chinese man in dramatic cool lighting, intense motion, sharp features, dynamic composition, cinematic",
        }
        subj_female_cold = {
            "melancholic": "a beautiful Chinese woman, long dark hair, soft cool light, cinematic solitude, quiet bearing",
            "mysterious": "a beautiful Chinese woman, long black hair, cool neon reflections, mysterious, cinematic noir",
            "dreamy": "a beautiful Chinese woman in misty moonlight, long flowing black hair, cool silver tones, ethereal atmosphere",
            "warm": "a beautiful Chinese woman in gentle twilight, long black hair, cool ambient light, elegant, cinematic beauty",
            "uplifting": "a beautiful Chinese woman in cool morning light, long hair flowing, graceful stance, cinematic",
            "energetic": "a beautiful Chinese woman in dramatic blue light, long black hair flying, powerful presence, dynamic composition, cinematic",
        }
        # melancholic/energetic → 男性；dreamy/warm/uplifting/mysterious → 女性
        # ★ 极低能量 + 梦幻/神秘情绪 → 返回空字符串，表示该曲更适合纯景/氛围，不强行注入人物角色
        if intensity < 0.18 and m in ("dreamy", "mysterious"):
            return ""  # 空 = 不建议人物 → LLM 可自由选择是否加入角色
        if m in ("melancholic", "energetic"):
            pool = subj_male_warm if warm else subj_male_cold
        else:
            pool = subj_female_warm if warm else subj_female_cold
        return pool.get(m, pool.get("dreamy", "a distinctive Chinese character in cinematic lighting"))
    subject = choose_subject(mood, is_warm, intensity)

    overall = {
        "genre": genre,
        "mood": mood,
        "moodZh": MOOD_ZH[mood],
        "tempoBpm": round(tempo, 1),
        "energy": round(overall_energy, 3),
        "loudness": global_loudness,
        "warmth": round(warmth, 3),
        "style": style,
        "colorPalette": palette,
        "suggestedSubject": subject,
        "mertMean": round(emb_mean, 4),
        "mertStd": round(emb_std, 4),
    }

    emit(99, "汇总分析结果…")
    print(json.dumps({"overall": overall, "segments": segments}, ensure_ascii=False))


if __name__ == "__main__":
    main()
