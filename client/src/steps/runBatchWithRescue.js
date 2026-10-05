import { sleep, COOLDOWN_MS } from '../api.js';

/**
 * 批量生成 + 失败自动抢救（脚本/文生图/图生视频三阶段通用）。
 *
 * - 第一遍：顺序生成全部 n 段，段间冷却 COOLDOWN_MS；任一段失败仅记录，不中断其余段。
 * - 抢救：第一遍结束后若仍有失败段，经过 rescueCooldownMs 冷却，再对失败段重生成；
 *   最多 rescueRounds 轮，轮间同样冷却。仍失败则交由调用方报错（绝不 mock 降级占位）。
 * - shouldCancel() 返回 true 时立即退出（用户取消）。
 *
 * 返回 { failed: number[], cancelled: boolean }：failed 为仍然失败的段下标（已尽力抢救），
 * cancelled 表示用户中途取消。调用方据此决定是否报错（列出 failed 段号）。
 */
export async function runBatchWithRescue({
  n,
  generateOne,
  shouldCancel,
  setProgress,
  setCooling,
  setPhase,
  rescueRounds = 2,
  rescueCooldownMs = COOLDOWN_MS * 2,
}) {
  const noop = () => {};
  const sp = setProgress || noop;
  const sc = setCooling || noop;
  const sp2 = setPhase || noop;
  const failed = [];

  // ── 第一遍：顺序生成全部段，失败仅记录不中断 ──
  for (let i = 0; i < n; i++) {
    if (shouldCancel()) return { failed, cancelled: true };
    sp(i);
    sp2('生成');
    try {
      await generateOne(i);
    } catch (e) {
      if (e && e.message === '已取消') return { failed, cancelled: true };
      failed.push(i); // 记录失败段，继续后面的段
    }
    if (shouldCancel()) return { failed, cancelled: true };
    if (i < n - 1) { sc(true); await sleep(COOLDOWN_MS); sc(false); }
  }

  // ── 抢救：冷却后仅对失败段重生成，最多 rescueRounds 轮 ──
  for (let round = 1; round <= rescueRounds && failed.length; round++) {
    sp2(`抢救（第 ${round}/${rescueRounds} 轮）`);
    await sleep(rescueCooldownMs); // 冷却时间后重新自动生成
    const still = [];
    for (let k = 0; k < failed.length; k++) {
      const i = failed[k];
      if (shouldCancel()) return { failed: still, cancelled: true };
      sp(i);
      try {
        await generateOne(i);
      } catch (e) {
        if (e && e.message === '已取消') return { failed: still, cancelled: true };
        still.push(i);
      }
      if (shouldCancel()) return { failed: still, cancelled: true };
      if (k < failed.length - 1) { sc(true); await sleep(COOLDOWN_MS); sc(false); }
    }
    if (still.length === 0) { failed.length = 0; break; }
    failed.length = 0; failed.push(...still);
  }

  return { failed, cancelled: false };
}
