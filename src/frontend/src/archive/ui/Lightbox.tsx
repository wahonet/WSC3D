import { useEffect } from 'react';
import { useStore } from '../store';

/** 全屏大图浏览(左右切换) */
export default function Lightbox() {
  const { lightbox, closeLightbox, openLightbox } = useStore();

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
      <span className="pv-close" onClick={closeLightbox}>✕</span>
      {photos.length > 1 && <span className="pv-nav pv-prev" onClick={() => nav(-1)}>‹</span>}
      {photos.length > 1 && <span className="pv-nav pv-next" onClick={() => nav(1)}>›</span>}
      <div className="pv-cap">{title} · {index + 1} / {photos.length}</div>
    </div>
  );
}
