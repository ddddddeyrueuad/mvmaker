import { useEffect, useRef, useState } from 'react';
import { fetchProgress } from '../api.js';

/**
 * 轮询后端处理进度。仅在 active 为 true 时轮询。
 * 返回 { progress, stalled }：
 *  - progress: { phase, percent, label, detail, active, ok, stalledMs, elapsedMs } | null
 *  - stalled: 距上次活动超过 stalledThresholdMs 且仍 active 时为 true（疑似卡死）
 */
export default function useProgress(jobId, active, { stalledThresholdMs = 45000, intervalMs = 1500 } = {}) {
  const [progress, setProgress] = useState(null);
  const [stalled, setStalled] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!active || !jobId) {
      setProgress(null);
      setStalled(false);
      return;
    }
    let timer = null;
    async function poll() {
      try {
        const p = await fetchProgress(jobId);
        if (!alive.current) return;
        setProgress(p);
        const isStalled = !!(p && p.active && p.stalledMs >= stalledThresholdMs);
        setStalled(isStalled);
      } catch {
        // 轮询失败不影响主流程，仅停止本轮
      } finally {
        if (alive.current) timer = setTimeout(poll, intervalMs);
      }
    }
    poll();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, active, stalledThresholdMs, intervalMs]);

  return { progress, stalled };
}
