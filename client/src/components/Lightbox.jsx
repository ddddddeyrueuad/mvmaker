import { useEffect } from 'react';

/**
 * 全屏灯箱：点击缩略图放大查看。
 * - 点背景 / 按 ESC / 点右上角 × 均可关闭
 * - type='video' 时播放视频，否则显示图片
 */
export default function Lightbox({ src, type = 'image', caption, onClose }) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // 打开时锁定背景滚动
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="关闭">×</button>
      <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
        {type === 'video'
          ? <video src={src} controls autoPlay loop className="lightbox-media" />
          : <img src={src} alt={caption || ''} className="lightbox-media" />}
        {caption && <div className="lightbox-caption">{caption}</div>}
      </div>
    </div>
  );
}
