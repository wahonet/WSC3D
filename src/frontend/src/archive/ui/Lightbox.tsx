import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { onEnterSpace } from '../../components/ui';

/** 全屏大图浏览(左右切换) */
export default function Lightbox() {
  const { lightbox, closeLightbox, openLightbox } = useStore(useShallow(s => ({ lightbox: s.lightbox, closeLightbox: s.closeLightbox, openLightbox: s.openLightbox })));

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.code === 'Escape') { ev.preventDefault(); closeLightbox(); }
      else if (ev.code === 'ArrowLeft') nav(-1);
      else if (ev.code === 'ArrowRight') nav(1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (!lightbox) return null;
  const { photos, index, title } = lightbox;
  const nav = (d: number) =>
    openLightbox(photos, (index + d + photos.length) % photos.length, title);

  return (
    <div className="pv-overlay" onPointerDown={e => { if (e.target === e.currentTarget) closeLightbox(); }}>
      <img src={photos[index]} alt="" />
      <span className="pv-close" role="button" tabIndex={0} aria-label="关闭大图" onClick={closeLightbox} onKeyDown={onEnterSpace(closeLightbox)}>✕</span>
      {photos.length > 1 && <span className="pv-nav pv-prev" role="button" tabIndex={0} aria-label="上一张" onClick={() => nav(-1)} onKeyDown={onEnterSpace(() => nav(-1))}>‹</span>}
      {photos.length > 1 && <span className="pv-nav pv-next" role="button" tabIndex={0} aria-label="下一张" onClick={() => nav(1)} onKeyDown={onEnterSpace(() => nav(1))}>›</span>}
      <div className="pv-cap">{title} · {index + 1} / {photos.length}</div>
    </div>
  );
}
