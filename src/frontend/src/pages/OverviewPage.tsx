import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { getAnnotation, listDocuments } from '../api'
import { useStore } from '../archive/store'
import { useApp } from '../store/useApp'
import { goToSection, previewDocument } from '../lib/navigation'
import { HOME_SLIDES, HOME_PLATES, HOME_STORIES, HOME_FIGURES, homeImage } from '../lib/homepageContent'
import summary from '../lib/homepageSummary.json'
import type { Annotation, AnnotationReference, DocumentInfo } from '../types'
import './overview.css'

type Destination = 'archive' | 'scene' | 'center' | 'motifs' | 'stories' | 'graph' | 'creative'
interface Props { onNavigate(section: Destination): void; onStone(id: string, section: 'archive' | 'research'): void; onSearch(query: string): void }
type Story = typeof HOME_STORIES[number]

const SCREENS = ['首页', '检索', '经典故事', '经典形象', '院落全景', '传承中心', '知识图谱']
const AREAS: [string, number][] = [['阙室', 20], ['西长廊', 40], ['后展厅', 46], ['北长廊', 20], ['室外', 24]]
const PLATE_NAMES = ['武梁祠东壁', '武梁祠西壁', '前石室后壁小龛后壁', '前石室后壁横额', '左石室屋顶后坡东段', '屋顶前坡东段画像', '左石室屋顶前坡西段', '前石室屋顶前坡西段', '前石室屋顶前坡东段', '左石室西壁下石', '左石室东壁下石', '左石室后壁小龛西侧', '左石室后壁小龛东侧', '左石室后壁东段承檐枋', '左石室小龛东壁', '左石室小龛西壁']
const KG_COLOR: Record<string, string> = { stone: '#8c6424', story: '#a3402c', person: '#3f6a73', object: '#6f7a3a' }
const KG_STATS = [['stone', '原石'], ['story', '故事'], ['person', '人物'], ['object', '器物']] as const
const CN_DIGITS = '〇一二三四五六七八九'

const storyCache = new Map<number, Annotation>()
let coreDocuments: Promise<Map<number, DocumentInfo>> | null = null
const loadCoreDocuments = () => coreDocuments ??= listDocuments('core').then(rows => new Map(rows.map(row => [row.id, row]))).catch(error => { coreDocuments = null; throw error })

const number = (value: number | undefined) => value == null ? '—' : value.toLocaleString('zh-CN')
const cnCode = (stone: string) => stone.replace(/\d/g, digit => CN_DIGITS[+digit])
const quoteSource = (record?: Annotation) => record?.references.find(ref => ref.kind === 'segment' && !!ref.document_id && !!ref.page_no && !!ref.text && !ref.source_missing)
const excerpt = (text: string) => { const flat = text.replace(/\s+/g, ''); return flat.length > 96 ? flat.slice(0, 96) + '…' : flat }

function citation(ref: AnnotationReference, documents: Map<number, DocumentInfo> | null) {
  const doc = ref.document_id == null ? undefined : documents?.get(ref.document_id)
  const authors = doc?.authors.trim() || ''
  let name = (doc?.title || ref.document_title || '').replace(/^\d+_/, '').replace(/[《》]/g, '').replace(/[_\s]*\d{6,}(\(\d+\))?$/, '').replace(/\s{2,}/g, ' ').trim()
  if (authors && name.endsWith(' ' + authors)) name = name.slice(0, -authors.length - 1)
  return [`${authors}《${name}》`, doc?.year, `第 ${ref.page_no} 页`].filter(Boolean).join('，')
}

const Arrow = () => <svg className="home-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
const image = (filename: string) => ({ '--img': `url(${homeImage(filename)})` }) as CSSProperties

export default function OverviewPage({ onNavigate, onStone, onSearch }: Props) {
  const root = useRef<HTMLDivElement>(null), goRef = useRef<(index: number) => void>(() => {})
  const stats = useStore(s => s.stats), stones = useStore(s => s.stones)
  const research = useApp(s => s.stats)
  const [screen, setScreen] = useState(0)
  const [slide, setSlide] = useState(-1), [heroVisible, setHeroVisible] = useState(true), [pageVisible, setPageVisible] = useState(!document.hidden)
  const [query, setQuery] = useState(''), [storyIndex, setStoryIndex] = useState(0)
  const [records, setRecords] = useState(() => new Map(storyCache))
  const [documents, setDocuments] = useState<Map<number, DocumentInfo> | null>(null)
  const story = HOME_STORIES[storyIndex], storyRecord = records.get(story.id)
  const names = useMemo(() => new Map(stones.map(stone => [stone.id, stone.name])), [stones])

  /* 一　巨幕轮播：6 秒一换，离开首屏或页面隐藏时暂停 */
  useEffect(() => { const frame = requestAnimationFrame(() => requestAnimationFrame(() => setSlide(0))); return () => cancelAnimationFrame(frame) }, [])
  useEffect(() => {
    if (slide < 0 || !heroVisible || !pageVisible) return
    const timer = setTimeout(() => setSlide(value => (value + 1) % HOME_SLIDES.length), 6000)
    return () => clearTimeout(timer)
  }, [slide, heroVisible, pageVisible])
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    const hero = root.current?.querySelector('[data-screen="0"]')
    const observer = new IntersectionObserver(([entry]) => setHeroVisible(entry.isIntersecting), { root: root.current, threshold: .3 })
    if (hero) observer.observe(hero)
    return () => { document.removeEventListener('visibilitychange', onVisibility); observer.disconnect() }
  }, [])

  /* 三　经典故事：引文取自各故事第一条带原文的文献引用 */
  useEffect(() => {
    let active = true
    for (const item of HOME_STORIES) {
      new Image().src = homeImage(item.image)
      if (storyCache.has(item.id)) continue
      void getAnnotation(item.id).then(row => {
        storyCache.set(item.id, row)
        if (active) setRecords(new Map(storyCache))
      }).catch(() => { /* 故事库页面仍可打开完整记录 */ })
    }
    void loadCoreDocuments().then(rows => { if (active) setDocuments(rows) }).catch(() => { /* 退回书名 */ })
    return () => { active = false }
  }, [])

  /* 整屏翻页：滚轮一格切换一屏；超出一屏高的分区先在区内滚动 */
  useEffect(() => {
    const host = root.current
    if (!host) return
    const screens = [...host.querySelectorAll<HTMLElement>('[data-screen]'), host.querySelector<HTMLElement>('.home-foot')!]
    const wide = matchMedia('(min-width: 1181px) and (min-height: 600px)'), fine = matchMedia('(pointer: fine)'), reduced = matchMedia('(prefers-reduced-motion: reduce)')
    let busy = false, frame = 0
    const stops = () => {
      const max = host.scrollHeight - host.clientHeight
      return screens.map((section, i) => {
        if (i === screens.length - 1) return { start: max, end: max }
        const start = Math.min(max, section.offsetTop)
        return { start, end: Math.min(max, Math.max(start, start + section.offsetHeight - host.clientHeight)) }
      })
    }
    const indexAt = (list: { start: number }[], y: number) => { let k = 0; list.forEach((p, i) => { if (p.start <= y + 4) k = i }); return k }
    const scrollToY = (y: number) => {
      if (reduced.matches) { host.scrollTop = y; return }
      busy = true
      const y0 = host.scrollTop, d = y - y0, t0 = performance.now(), duration = 850
      const ease = (p: number) => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / duration); host.scrollTop = y0 + d * ease(p)
        if (p < 1) frame = requestAnimationFrame(step); else setTimeout(() => { busy = false }, 380)
      }
      cancelAnimationFrame(frame); frame = requestAnimationFrame(step)
    }
    const go = (index: number) => {
      const list = stops(), i = Math.max(0, Math.min(list.length - 1, index))
      if (!wide.matches) { screens[i].scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth' }); return }
      scrollToY(list[i].start)
    }
    goRef.current = go
    const move = (dir: number) => {
      const list = stops(), y = host.scrollTop, i = indexAt(list, y), p = list[i]
      if (dir > 0) {
        if (y < p.end - 4) return false
        if (i + 1 < list.length) scrollToY(list[i + 1].start)
        return true
      }
      if (y > p.end + 4) { scrollToY(p.end); return true }
      if (y > p.start + 4) return false
      if (i > 0) scrollToY(list[i - 1].end)
      return true
    }
    const onWheel = (event: WheelEvent) => {
      if (!wide.matches || !fine.matches || event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
      if (busy) { event.preventDefault(); return }
      if (Math.abs(event.deltaY) < 3) return
      if (move(Math.sign(event.deltaY))) event.preventDefault()
    }
    const onKey = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null
      if (!wide.matches || event.altKey || event.ctrlKey || event.metaKey || (active && active !== document.body && !host.contains(active)) || /INPUT|TEXTAREA|SELECT/.test(active?.tagName || '')) return
      if (event.key === ' ' && /BUTTON|A/.test(active?.tagName || '')) return
      const dir = ({ PageDown: 1, ArrowDown: 1, ' ': event.shiftKey ? -1 : 1, PageUp: -1, ArrowUp: -1 } as Record<string, number>)[event.key]
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); go(event.key === 'Home' ? 0 : screens.length - 1); return }
      if (!dir) return
      if (busy || move(dir)) event.preventDefault()
    }
    const sync = () => setScreen(Math.min(indexAt(stops(), host.scrollTop + host.clientHeight * .35), SCREENS.length - 1))
    host.addEventListener('wheel', onWheel, { passive: false })
    host.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', sync)
    sync()
    return () => {
      cancelAnimationFrame(frame)
      host.removeEventListener('wheel', onWheel); host.removeEventListener('scroll', sync)
      window.removeEventListener('keydown', onKey); window.removeEventListener('resize', sync)
    }
  }, [])

  const openStory = (item: Story) => goToSection('stories', { story: item.id, story_stone: item.stone, story_candidates: null })
  const openReference = (ref: AnnotationReference) => {
    if (ref.document_id != null) previewDocument({ collection: 'core', documentId: ref.document_id, pageNo: ref.page_no || 1, pageId: ref.page_id || undefined, segmentId: ref.segment_id || undefined })
  }
  const figure = (label: string, value: number | undefined, unit: string, prefix = '') => <div key={label}><dt>{label}</dt><dd>{prefix && <small className="home-pre">{prefix}</small>}{number(value)}<small>{unit}</small></dd></div>
  const heading = (text: string, link: string, destination: Destination) => <header className="home-sec-head"><h2>{text}</h2><button type="button" onClick={() => onNavigate(destination)}>{link} <Arrow /></button></header>
  const poster = (title: ReactNode, label: string, onClick: () => void, small?: string, focusable = true) =>
    <div className="home-poster"><button type="button" className="home-frame" onClick={onClick} tabIndex={focusable ? 0 : -1} aria-label={label}><span className="home-big">{title}</span>{small && <span className="home-small">{small}</span>}</button></div>

  const kg = useMemo(() => {
    const cx = 380, cy = 235, nodes = summary.graph.preview
    return nodes.map((node, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / nodes.length, r = i % 2 ? 196 : 150
      const x = cx + r * 1.3 * Math.cos(a), y = cy + r * Math.sin(a)
      const anchor: 'middle' | 'start' | 'end' = Math.abs(Math.cos(a)) < .25 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end'
      const tx = anchor === 'middle' ? x : x + (anchor === 'start' ? 11 : -11), ty = anchor === 'middle' ? y + (y < cy ? -12 : 21) : y + 4.5
      return { ...node, x, y, tx, ty, anchor }
    })
  }, [])
  const openNode = (id: string) => goToSection('graph', { kg_node: id, kg_stone: null })

  return <div className="scholar-home" ref={root}>
    <h1 className="home-sr">嘉祥武氏墓群石刻</h1>
    <ol className="home-pager" aria-label="页面分区">{SCREENS.map((name, i) => <li key={name}><button type="button" className={screen === i ? 'on' : ''} onClick={() => goRef.current(i)} aria-label={name} aria-current={screen === i ? 'true' : 'false'}><span>{name}</span></button></li>)}</ol>

    {/* 一　巨幕动画墙：八幅拓片轮播，下方是全库统计 */}
    <section className="home-screen home-hero" data-screen="0" aria-roledescription="轮播" aria-label="画像石巨幕">
      {HOME_SLIDES.map((item, i) => <figure key={item.image} className={`home-slide${slide === i ? ' on' : ''}`} style={image(item.image)} aria-hidden={slide !== i}>
        <div className="home-slide-bg" />
        <figcaption>{poster(item.title, `查看${item.title}的原石档案`, () => onStone(item.stone, 'archive'), `${cnCode(item.stone)}　${item.place}`, slide === i)}</figcaption>
      </figure>)}
      <button type="button" className="home-down" onClick={() => goRef.current(1)} aria-label="向下浏览"><span>向下浏览</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg></button>
      <div className="home-hero-foot"><div className="home-wrap">
        <dl className="home-figures">
          {figure('画像石', research?.stones, '件')}{figure('故事形象', summary.stories, '个')}{figure('画像形象', summary.motifs, '个')}
          {figure('知识图谱', summary.graph.meta.total_nodes, '个节点')}{figure('收录文献', stats ? stats.books + (stats.core_books ?? 10) : undefined, '部')}
        </dl>
        <div className="home-thumbs" role="tablist" aria-label="切换画面">{HOME_SLIDES.map((item, i) => <button key={item.image} type="button" role="tab" style={image(item.image)} className={slide === i ? 'on' : ''} aria-selected={slide === i} aria-label={item.title} onClick={() => setSlide(i)} />)}</div>
      </div></div>
    </section>

    {/* 二　检索 + 精品十六幅 */}
    <section className="home-screen home-sec-search" data-screen="1" aria-label="检索"><div className="home-wrap">
      <form className="home-search" role="search" onSubmit={event => { event.preventDefault(); if (query.trim()) onSearch(query.trim()) }}>
        <input aria-label="检索石刻、人物、故事与文献" maxLength={1000} placeholder="输入石刻编号、人物或故事，例如：武037、荆轲、二桃杀三士" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="submit"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>检索</button>
      </form>
      {heading('精品十六幅', '全部文物档案', 'archive')}
      <div className="home-plates">{HOME_PLATES.map((id, i) => {
        const code = String(id).padStart(3, '0'), name = names.get(`武${code}`) || PLATE_NAMES[i]
        return <button key={id} type="button" title={`武${code} ${name}`} onClick={() => onStone(`武${code}`, 'archive')}><span className="home-plate"><img src={homeImage(`plate-${code}.jpg`)} alt={`${name}拓片`} loading="lazy" /></span><code>武{code}</code><strong>{name}</strong></button>
      })}</div>
    </div></section>

    {/* 三　经典故事：左侧大图，右侧切换 */}
    <section className="home-screen home-sec-stories" data-screen="2" aria-label="经典故事"><div className="home-wrap">
      {heading('经典故事', '故事形象库', 'stories')}
      <div className="home-tales">
        <figure className="home-tale-art"><button type="button" className="home-tale-pic" onClick={() => openStory(story)} aria-label={`打开故事：${story.title}`}><img src={homeImage(story.image)} alt={`${story.title}画像拓片局部`} /></button>
          <figcaption><span>{story.stone} · {story.place}</span><span>{storyRecord ? `${storyRecord.references.length} 条文献与插图` : ''}</span></figcaption></figure>
        <ol className="home-tale-list">{HOME_STORIES.map((item, i) => {
          const source = quoteSource(records.get(item.id))
          return <li key={item.id} className={i === storyIndex ? 'on' : ''}>
            <button type="button" aria-expanded={i === storyIndex} onClick={() => setStoryIndex(i)} onMouseEnter={() => setStoryIndex(i)}><i>{String(i + 1).padStart(2, '0')}</i><b>{item.title}</b><small>{item.stone} · {item.place}</small></button>
            <div className="home-tale-body">{source && <q>{excerpt(source.text)}</q>}<p>{source && <button type="button" className="home-cite" title="查看原书页" onClick={() => openReference(source)}>{citation(source, documents)}</button>}<button type="button" className="home-more" onClick={() => openStory(item)}>查看故事 <Arrow /></button></p></div>
          </li>
        })}</ol>
      </div>
    </div></section>

    {/* 四　经典形象 */}
    <section className="home-screen home-sec-figures" data-screen="3" aria-label="经典形象"><div className="home-wrap">
      {heading('经典形象', '画像形象库', 'motifs')}
      <div className="home-specs">{HOME_FIGURES.map(item => <button key={item.id} type="button" className="home-spec" onClick={() => goToSection('motifs', { motif: item.id, motif_candidates: null })}><span className="home-spec-pic"><img src={homeImage(`fig-${item.id}.png`)} alt={item.title} loading="lazy" /></span><strong>{item.title}</strong><small>{item.stone} · {item.place}</small></button>)}</div>
    </div></section>

    {/* 五　武氏墓群石刻博物馆全景：版式同首屏 */}
    <section className="home-screen home-stage" data-screen="4" aria-label="武氏墓群石刻博物馆全景" style={image('court-aerial.jpg')}>
      <div className="home-stage-bg" role="img" aria-label="武氏墓群石刻博物馆院落三维场景鸟瞰" />
      {poster(<>武氏墓群石刻<br />博物馆全景</>, '进入武氏墓群石刻博物馆全景', () => onNavigate('scene'))}
      <div className="home-hero-foot"><div className="home-wrap">
        <dl className="home-figures">{AREAS.map(([area, fallback]) => figure(area, stats?.by_area[area] ?? fallback, '件'))}</dl>
        <button type="button" className="home-enter" onClick={() => onNavigate('scene')} aria-label="进入院落三维全景"><Arrow /></button>
      </div></div>
    </section>

    {/* 六　武氏祠汉文化保护传承中心：版式同首屏 */}
    <section className="home-screen home-stage" data-screen="5" aria-label="武氏祠汉文化保护传承中心" style={image('center-aerial.jpg')}>
      <div className="home-stage-bg" role="img" aria-label="武氏祠汉文化保护传承中心三维场景鸟瞰" />
      {poster(<>武氏祠汉文化<br />保护传承中心</>, '进入武氏祠汉文化保护传承中心', () => onNavigate('center'))}
      <div className="home-hero-foot"><div className="home-wrap">
        <dl className="home-figures"><div><dt>占地</dt><dd><small className="home-pre">约</small>4.47<small>公顷</small></dd></div><div><dt>建筑面积</dt><dd><small className="home-pre">约</small>17,000<small>平方米</small></dd></div></dl>
        <button type="button" className="home-enter" onClick={() => onNavigate('center')} aria-label="进入传承中心三维场景"><Arrow /></button>
      </div></div>
    </section>

    {/* 七　知识图谱：示意 + 入口 */}
    <section className="home-screen home-sec-graph" data-screen="6" aria-label="知识图谱"><div className="home-wrap">
      {heading('知识图谱', '进入知识图谱', 'graph')}
      <div className="home-graph">
        <div>
          <p>依据核心十部文献整理原石、故事、人物与器物之间的关系。现有关系均为候选，尚待逐条核对原书页面与图像。</p>
          <dl className="home-kg-stats">
            {KG_STATS.map(([kind, name]) => <div key={kind}><dt><i style={{ background: KG_COLOR[kind] }} />{name}</dt><dd>{number(summary.graph.meta.counts[kind])}</dd></div>)}
            <div><dt>关系</dt><dd>{number(summary.graph.meta.total_edges)}</dd></div>
            <div><dt>文献依据</dt><dd>{number(summary.graph.meta.evidence_total)}</dd></div>
          </dl>
          <button type="button" className="home-go" onClick={() => onNavigate('graph')}>进入知识图谱 <Arrow /></button>
        </div>
        <figure className="home-kg-pic">
          <svg viewBox="0 0 760 470" role="img" aria-label={`“${summary.graph.hub.label}”在知识图谱中的关联`}>
            {kg.map(node => <line key={node.id} className="home-kg-edge" x1="380" y1="235" x2={node.x.toFixed(1)} y2={node.y.toFixed(1)} />)}
            {kg.map(node => <g key={node.id} className="home-kg-node" role="button" tabIndex={0} aria-label={`查看图谱节点${node.label}`} onClick={() => openNode(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openNode(node.id) } }}>
              <circle cx={node.x.toFixed(1)} cy={node.y.toFixed(1)} r={node.kind === 'stone' ? 7.5 : 6} fill={KG_COLOR[node.kind]} /><text x={node.tx.toFixed(1)} y={node.ty.toFixed(1)} textAnchor={node.anchor}>{node.label}</text></g>)}
            <g className="home-kg-node hub" role="button" tabIndex={0} aria-label={`查看图谱节点${summary.graph.hub.label}`} onClick={() => openNode(summary.graph.hub.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openNode(summary.graph.hub.id) } }}>
              <circle cx="380" cy="235" r="13" fill={KG_COLOR.story} /><text x="380" y="271" textAnchor="middle">{summary.graph.hub.label}</text></g>
          </svg>
          <figcaption>示例：“{summary.graph.hub.label}”的关联（取自图谱数据）</figcaption>
        </figure>
      </div>
    </div></section>

    <footer className="home-foot">
      <div className="home-wrap home-foot-in">
        <button type="button" className="home-logo" onClick={() => goRef.current(0)}><img src="/brand/culture-jining.png" alt="" /><span><b>嘉祥武氏墓群石刻</b><small>数字档案与图像研究平台</small></span></button>
        <section aria-labelledby="home-f-contact">
          <h4 id="home-f-contact">联系我们</h4>
          <dl>
            <dt>地址</dt><dd>武氏墓群石刻博物馆<br />山东省济宁市嘉祥县纸坊镇武翟山村</dd>
            <dt>电话</dt><dd><a href="tel:0537-6987702">0537-6987702</a></dd>
            <dt>邮件</dt><dd><a href="mailto:jxww702@163.com">jxww702@163.com</a></dd>
          </dl>
        </section>
        <section aria-labelledby="home-f-about">
          <h4 id="home-f-about">关于我们</h4>
          <ul><li><span>本馆介绍</span></li><li><span>平台说明</span></li><li><span>版权声明</span></li></ul>
        </section>
      </div>
      <div className="home-copy">版权所有：嘉祥县文物旅游服务中心</div>
    </footer>
  </div>
}
