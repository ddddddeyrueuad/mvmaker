import React from 'react';
import ProgressBar from './ProgressBar.jsx';
import useProgress from '../hooks/useProgress.js';

/**
 * 通用「后端驱动」进度条：轮询 GET /api/job/:id/progress，
 * 以百分比展示当前处理阶段 + 详情，并在疑似卡死时给出提示。
 */
export default function StoryProgress({ jobId }) {
  const { progress, stalled } = useProgress(jobId, true);
  if (!progress || !progress.active) return null;
  return (
    <div className="proc-progress">
      <ProgressBar
        percent={progress.percent}
        label={progress.label || '处理中…'}
        detail={progress.detail}
        warn={stalled}
      />
      {stalled && (
        <div className="banner warn">
          ⚠️ 任务可能卡死：已超过 {Math.round(progress.stalledMs / 1000)} 秒无新进度更新。
          若后端日志也无变化，请在右侧日志面板点击「清空」后重试，或检查 Agnes 服务是否可用。
        </div>
      )}
    </div>
  );
}
