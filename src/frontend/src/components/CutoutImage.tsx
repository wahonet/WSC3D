import { useEffect, useRef, useState } from 'react'
import { ImageOff, LoaderCircle } from 'lucide-react'
import { renderMotifPreview, type Motif } from '../lib/motifCutouts'
import { renderStoryPreview, type StoryCutout, type StoryView } from '../lib/storyCutouts'

export default function CutoutImage({ motif, large = false, ready, view, candidates = false }: {
  motif: Motif | StoryCutout; large?: boolean; ready?: (blob: Blob) => void; view?: StoryView; candidates?: boolean
}) {
  const host = useRef<HTMLDivElement>(null), callback = useRef(ready)
  callback.current = ready
  const [visible, setVisible] = useState(large)
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const scopeLabel = motif.annotation.level === 'band' ? '整体纹带' : '独立切图'
  const fingerprint = JSON.stringify([motif.points, motif.annotation.geometry.native_mask, motif.annotation.geometry.image_version,
    view && (motif as StoryCutout).motifs.map(m => [m.annotation.id, m.points, m.annotation.geometry.native_mask, m.annotation.geometry.image_version, m.annotation.review_status])])
  useEffect(() => {
    if (visible || !host.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '250px' })
    observer.observe(host.current); return () => observer.disconnect()
  }, [visible])
  useEffect(() => {
    if (!visible) return
    let active = true, objectUrl = ''
    setUrl(''); setError('')
    const render = view ? renderStoryPreview(motif as StoryCutout, view, large ? 1800 : 650, candidates) : renderMotifPreview(motif, large ? 1800 : 650)
    void render.then(blob => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); callback.current?.(blob)
    }).catch(reason => { if (active) setError(reason.message) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [visible, motif.annotation.id, motif.asset.id, motif.asset.extra.cutout_rotation_ccw, fingerprint, large, view, candidates, retry])
  return <div ref={host} className={`motif-cutout${large ? ' is-large' : ''}`}>
    {url ? <img src={url} alt={`${motif.annotation.label} · ${motif.stone.id}${view ? view === 'scene' ? '原图场景' : '保留原位置的形象组合' : scopeLabel}`} /> : error ?
      <span className="motif-image-error"><ImageOff size={20} />{error}{large ? <button onClick={event => { event.stopPropagation(); setRetry(value => value + 1) }}>重试</button> : <small>点开详情重试</small>}</span> :
      <span className="motif-image-loading" role="status"><LoaderCircle size={20} />{visible ? '正在读取图像…' : view ? '原图场景' : scopeLabel}</span>}
  </div>
}
