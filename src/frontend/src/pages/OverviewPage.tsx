import { useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, Landmark, Sparkles, Image as ImageIcon, MapPin, Network } from 'lucide-react'
import { useStore } from '../archive/store'
import type { StoneDetail } from '../archive/types'
import './overview.css'

type Destination = 'archive' | 'scene' | 'research' | 'library' | 'search' | 'graph'
interface Props { onNavigate(section: Destination): void; onStone(id: string, section: 'archive' | 'research'): void }
interface Plate { src: string }
const plateCache = new Map<string, Plate>()

/** Use the archive's own versioned images, so every image leads back to its source. */
export default function OverviewPage({ onNavigate, onStone }: Props) {
  const stones = useStore(s => s.stones)
  const [plates, setPlates] = useState<Record<string, Plate>>(() => Object.fromEntries(plateCache))
  const featured = stones.filter(stone => stone.collections?.includes('精品16幅'))
  const ids = featured.map(stone => stone.id).join(',')

  useEffect(() => {
    const abort = new AbortController()
    const wanted = ids.split(',').filter(Boolean)
    for (const id of wanted) {
      if (plateCache.has(id)) continue
      void fetch(`/api/archive/stones/${encodeURIComponent(id)}`, { signal: abort.signal })
        .then(response => { if (!response.ok) throw new Error('影像暂不可用'); return response.json() as Promise<StoneDetail> })
        .then(detail => {
          const version = detail.media_versions.find(v => v.kind === 'rubbing' && v.label.includes('广陵'))
            || detail.media_versions.find(v => v.kind === 'rubbing') || detail.media_versions[0]
          const item = version?.items.find(i => i.label.includes('image')) || version?.items[0]
          if (!item || abort.signal.aborted) return
          const plate = { src: item.thumbnail_url || item.url }
          plateCache.set(id, plate)
          setPlates(current => ({ ...current, [id]: plate }))
        }).catch(() => { /* A missing image must not block opening its archive. */ })
    }
    return () => abort.abort()
  }, [ids])

  return <div className="museum-overview">
    <div className="museum-content">
      <section className="museum-hero" aria-labelledby="overview-title">
        <div className="museum-intro">
          <p className="museum-eyebrow"><MapPin size={13} strokeWidth={1.5} /> 济宁 · 嘉祥 <span className="museum-eyebrow-line" /> 汉画像石</p>
          <h1 id="overview-title"><span>循石迹</span><span>见汉风</span></h1>
          <p className="museum-lead">在原石、拓片与文献之间，细读武氏墓群石刻的图像世界。</p>
          <div className="museum-actions">
            <button className="museum-primary" onClick={() => onNavigate('archive')}>浏览文物档案 <ArrowRight size={17} /></button>
            <button className="museum-secondary" onClick={() => onNavigate('scene')}>走进院落 <ArrowUpRight size={16} /></button>
          </div>
          <div className="museum-hero-note"><span>原石</span><i /><span>拓片</span><i /><span>文献</span><i /><span>研究</span></div>
        </div>
        <figure className="museum-hero-art">
          <img src="/brand/museum-gate.webp" width="1536" height="1024" fetchPriority="high" alt="武氏墓群石刻博物馆正门淡彩线描：灰石双阙、朱红门扉与通往院落的石径" />
          <figcaption>武氏墓群石刻博物馆 · 正门</figcaption>
        </figure>
      </section>

      <nav className="museum-paths" aria-label="探索馆藏">
        {[{ section: 'archive' as const, icon: Landmark, title: '文物档案', text: '阅览原石、照片与拓片' }, { section: 'scene' as const, icon: MapPin, title: '院落全景', text: '循着空间，探访石刻所在' }, { section: 'graph' as const, icon: Network, title: '知识图谱', text: '串联人物、物象与故事' }, { section: 'search' as const, icon: Sparkles, title: 'AI问答', text: '从问题出发，查阅图像与文献' }].map(({ section, icon: Icon, title, text }, index) => <button key={section} onClick={() => onNavigate(section)}><span className="museum-path-number">0{index + 1}</span><span className="museum-path-icon"><Icon size={22} strokeWidth={1.5} /></span><span><strong>{title}</strong><small>{text}</small></span><ArrowUpRight size={17} /></button>)}
      </nav>

      <section className="museum-collection" aria-labelledby="collection-title">
        <div className="museum-section-heading"><div><p className="museum-eyebrow">SELECTED COLLECTION</p><h2 id="collection-title">精品十六幅 <span>从代表作品开始读图</span></h2></div><button onClick={() => onNavigate('archive')}>全部馆藏 <ArrowRight size={16} /></button></div>
        <div className="museum-grid">
          {featured.map((stone, index) => <button key={stone.id} className="museum-card" onClick={() => onStone(stone.id, 'archive')}>
            <span className="museum-card-image">{plates[stone.id] ? <img src={plates[stone.id].src} alt={`${stone.name}拓片`} loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden' }} /> : <ImageIcon size={30} />}<span className="museum-card-number">{String(index + 1).padStart(2, '0')}</span></span>
            <span className="museum-card-body"><span className="museum-card-code">{stone.id}<ArrowUpRight size={15} /></span><strong>{stone.name}</strong><small>{stone.location}</small></span>
          </button>)}
        </div>
        {!featured.length && <p className="museum-loading" role="status">正在载入精品档案…</p>}
      </section>
      <p className="museum-colophon">武氏墓群石刻 · 数字档案与图像研究平台 <span>济宁 · 嘉祥</span></p>
    </div>
  </div>
}
