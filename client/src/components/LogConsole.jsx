import React, { useEffect, useRef, useState } from 'react';
import { fetchLogs } from '../api.js';

const STEP_LABEL = {
  upload: '上传', storyboard: '分镜', image: '文生图', video: '图生视频', compose: '合成', system: '系统',
};

function ts(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export default function LogConsole({ jobId }) {
  const [logs, setLogs] = useState([]);
  const [since, setSince] = useState(0);
  const [open, setOpen] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!jobId) { setLogs([]); setSince(0); return; }
    let alive = true;
    let timer = null;

    async function poll() {
      try {
        const data = await fetchLogs(jobId, since);
        if (!alive) return;
        if (data.logs && data.logs.length) {
          setLogs((prev) => [...prev, ...data.logs].slice(-500));
          setSince(data.nextSince || since);
          if (autoScroll && boxRef.current) {
            boxRef.current.scrollTop = boxRef.current.scrollHeight;
          }
        }
      } catch (e) {
        if (alive) console.warn('logs poll failed', e.message);
      } finally {
        if (alive) timer = setTimeout(poll, 1500);
      }
    }
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [jobId, since, autoScroll]);

  const errCount = logs.filter((l) => l.level === 'error').length;

  return (
    <section className="log-console">
      <div className="log-head" onClick={() => setOpen((o) => !o)}>
        <span>📋 处理日志{errCount ? `（⚠️ ${errCount} 条错误）` : ''}</span>
        <span className="log-tools">
          <label onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> 自动滚动
          </label>
          <button className="link" onClick={(e) => { e.stopPropagation(); setLogs([]); setSince(0); }}>清空</button>
          <span className="log-toggle">{open ? '▼' : '▲'}</span>
        </span>
      </div>
      {open && (
        <div className="log-body" ref={boxRef}>
          {logs.length === 0 && <div className="log-line info">（暂无日志，开始操作后这里会显示详细处理与报错信息）</div>}
          {logs.filter((l) => l.level !== 'debug').map((l, i) => (
            <div key={i} className={`log-line ${l.level}`}>
              <span className="log-ts">{ts(l.ts)}</span>
              <span className="log-step">[{STEP_LABEL[l.step] || l.step}]</span>
              <span className="log-msg">{l.msg}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
