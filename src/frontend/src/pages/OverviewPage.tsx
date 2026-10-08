import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, ChevronDown, Pause, Play, Search } from 'lucide-react'
import { getAnnotation } from '../api'
import { useStore } from '../archive/store'
import { useApp } from '../store/useApp'
import { goToSection, previewDocument } from '../lib/navigation'
import { HOME_SLIDES, HOME_PLATES, HOME_STORIES, HOME_FIGURES, homeImage } from '../lib/homepageContent'
import summary from '../lib/homepageSummary.json'
import type { Annotation, AnnotationReference } from '../types'
import './overview.css'

type Destination = 'archive' | 'scene' | 'center' | 'motifs' | 'stories' | 'graph' | 'creative'
interface Props { onNavigate(section: Destination): void; onStone(id: string, section: 'archive' | 'research'): void; onSearch(query: string): void }
const SECTIONS = ['首页', '精品十六幅', '经典故事', '经典形象', '院落全景', '传承中心', '知识图谱']
const AREAS = ['阙室', '西长廊', '后展厅', '北长廊', '室外']
const storyCache = new Map<number, Annotation>()
const COLORS: Record<string, string> = { stone: '#b99658', story: '#9073a7', person: '#ad6754', object: '#6c9396' }
const PLATE_NAMES = ['武梁祠东壁', '武梁祠西壁', '前石室后壁小龛后壁', '前石室后壁横额', '左石室屋顶后坡东段', '屋顶前坡东段画像', '左石室屋顶前坡西段', '前石室屋顶前坡西段', '前石室屋顶前坡东段', '左石室西壁下石', '左石室东壁下石', '左石室后壁小龛西侧', '左石室后壁小龛东侧', '左石室后壁东段承檐枋', '左石室小龛东壁', '左石室小龛西壁']
const number = (value: number | undefined) => value == null ? '—' : value.toLocaleString('zh-CN')
const title = (text: string) => text.replace(/^\d+_/, '').replace(/[《》]/g, '').replace(/[_\s]*\d{6,}(\(\d+\))?$/, '').trim()

export default function OverviewPage({ onNavigate, onStone, onSearch }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const stats = useStore(s => s.stats), stones = useStore(s => s.stones)
  const research = useApp(s => s.stats)
  const [screen, setScreen] = useState(0), [slide, setSlide] = useState(0), [paused, setPaused] = useState(false)
  const [query, setQuery] = useState(''), [storyIndex, setStoryIndex] = useState(0)
  const [stories, setStories] = useState(() => new Map(storyCache))
  const story = HOME_STORIES[storyIndex], record = stories.get(story.id)
  const source = record?.references.find(ref => ref.kind === 'segment' && !!ref.document_id && !!ref.page_no && !!ref.text && !ref.source_missing)
  const names = useMemo(() => new Map(stones.map(stone => [stone.id, stone.name])), [stones])
  const graphNodes = summary.graph.preview.map((node, i, all) => {
    const angle = -Math.PI / 2 + i / all.length * Math.PI * 2
    return { ...node, x: 345 + Math.cos(angle) * (i % 2 ? 240 : 180), y: 220 + Math.sin(angle) * (i % 2 ? 163 : 115) }
  })

  useEffect(() => {
    const host = root.current
    if (!host) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) setScreen(Number((entry.target as HTMLElement).dataset.screen))
    }, { root: host, rootMargin: '-35% 0px -45% 0px' })
    host.querySelectorAll('[data-screen]').forEach(section => observer.observe(section))
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (paused || screen !== 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = setInterval(() => { if (!document.hidden) setSlide(value => (value + 1) % HOME_SLIDES.length) }, 8000)
    return () => clearInterval(timer)
  }, [paused, screen, slide])
  useEffect(() => {
    let active = true
    if (storyCache.has(story.id)) { setStories(new Map(storyCache)); return }
    void getAnnotation(story.id).then(row => {
      storyCache.set(story.id, row)
      if (active) setStories(new Map(storyCache))
    }).catch(() => { /* The real story page remains available if this excerpt fails. */ })
    return () => { active = false }
  }, [story.id])

  function scrollTo(index: number) {
    root.current?.querySelector(`[data-screen="${index}"]`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
  }
  function openStory() { goToSection('stories', { story: story.id, story_stone: story.stone, story_candidates: null }) }
  function openReference(reference: AnnotationReference) {
    if (reference.document_id != null) previewDocument({ collection: 'core', documentId: reference.document_id, pageNo: reference.page_no || 1, pageId: reference.page_id || undefined, segmentId: reference.segment_id || undefined })
  }
  const count = (label: string, value: number | undefined, unit: string) => <div key={label}><dt>{label}</dt><dd>{number(value)}<small>{unit}</small></dd></div>
  const heading = (text: string, link: string, destination: Destination) => <header className="home-section-heading"><h2>{text}</h2><button onClick={() => onNavigate(destination)}>{link}<ArrowRight size={16} /></button></header>

  return <div className="scholar-home" ref={root}>
    <h1 className="home-sr">嘉祥武氏墓群石刻</h1>
    <nav className="home-pager" aria-label="首页分区">{SECTIONS.map((name, index) => <button key={name} className={screen === index ? 'on' : ''} onClick={() => scrollTo(index)} aria-label={`浏览${name}`} aria-current={screen === index ? 'location' : undefined}><span>{name}</span></button>)}</nav>
    <section className="home-screen home-hero" data-screen="0" aria-label="画像石巨幕" aria-roledescription="轮播">
      {HOME_SLIDES.map((item, index) => <figure key={item.image} className={`home-slide${slide === index ? ' on' : ''}`} aria-hidden={slide !== index}>
        <img className="home-wall" src={homeImage(item.image)} alt="" fetchPriority={index === 0 ? 'high' : 'auto'} />
        <figcaption className="home-poster"><button className="home-title-frame" onClick={() => onStone(item.stone, 'archive')} tabIndex={slide === index ? 0 : -1} aria-label={`查看${item.title}的原石档案`}><h2>{item.title}</h2><span>{item.stone}　{item.place}</span></button></figcaption>
      </figure>)}
      <button className="home-down" onClick={() => scrollTo(1)} aria-label="向下浏览"><span>向下浏览</span><ChevronDown size={22} /></button>
      <div className="home-screen-foot"><div className="home-wrap">
        <dl className="home-numbers">{count('画像石', research?.stones, '件')}{count('故事形象', summary.stories, '个')}{count('画像形象', summary.motifs, '个')}{count('知识图谱', summary.graph.meta.total_nodes, '个节点')}{count('收录文献', stats ? stats.books + (stats.core_books ?? 10) : undefined, '部')}</dl>
        <div className="home-thumbs" role="group" aria-label="切换拓片">{HOME_SLIDES.map((item, index) => <button key={item.image} aria-label={`展示${item.title}`} aria-pressed={slide === index} onClick={() => { setSlide(index); setPaused(true) }} className={slide === index ? 'on' : ''}><img src={homeImage(item.image)} alt="" /></button>)}<button className="home-play" aria-label={paused ? '播放拓片轮播' : '暂停拓片轮播'} onClick={() => setPaused(value => !value)}>{paused ? <Play size={14} /> : <Pause size={14} />}</button></div>
      </div></div>
    </section>

    <section className="home-screen home-search-section" data-screen="1" aria-label="精品十六幅"><div className="home-wrap">
      <form className="home-search" role="search" onSubmit={event => { event.preventDefault(); if (query.trim()) onSearch(query.trim()) }}><input aria-label="检索石刻、人物、故事与文献" maxLength={1000} placeholder="输入石刻编号、人物或故事，例如：武037、荆轲、二桃杀三士" value={query} onChange={event => setQuery(event.target.value)} /><button type="submit" disabled={!query.trim()}><Search size={18} />检索</button></form>
      {heading('精品十六幅', '全部文物档案', 'archive')}
      <div className="home-plates">{HOME_PLATES.map((id, index) => { const code = id.toString().padStart(3, '0'), name = names.get(`武${code}`) || PLATE_NAMES[index]; return <button key={id} onClick={() => onStone(`武${code}`, 'archive')} title={name}><span className="home-plate"><img src={homeImage(`plate-${code}.jpg`)} alt={name} loading="lazy" /></span><code>武{code}</code><strong>{name}</strong></button> })}</div>
    </div></section>

    <section className="home-screen home-stories" data-screen="2" aria-label="经典故事"><div className="home-wrap">
      {heading('经典故事', '故事形象库', 'stories')}
      <div className="home-tales"><figure className="home-tale-art"><button onClick={openStory} aria-label={`打开故事：${story.title}`}><img src={homeImage(story.image)} alt={`${story.title}画像拓片局部`} loading="lazy" /></button><figcaption><span>{story.stone} · {story.place}</span><span>{record ? `${record.references.length} 条文献与插图` : ''}</span></figcaption></figure>
        <ol className="home-tale-list">{HOME_STORIES.map((item, index) => <li className={index === storyIndex ? 'on' : ''} key={item.id}><button className="home-tale-toggle" onClick={() => setStoryIndex(index)} aria-expanded={index === storyIndex} aria-controls={`home-story-${item.id}`}><i>{String(index + 1).padStart(2, '0')}</i><b>{item.title}</b><small>{item.stone}</small></button>{index === storyIndex && <div className="home-tale-body" id={`home-story-${item.id}`}>
          {source && <><blockquote>{source.text}</blockquote><button className="home-citation" onClick={() => openReference(source)}>{title(source.document_title || '')} · 第 {source.page_no} 页<ArrowUpRight size={13} /></button></>}
          <button className="home-more" onClick={openStory}>查看故事<ArrowRight size={14} /></button>
        </div>}</li>)}</ol>
      </div>
    </div></section>

    <section className="home-screen" data-screen="3" aria-label="经典形象"><div className="home-wrap">
      {heading('经典形象', '画像形象库', 'motifs')}
      <div className="home-specimens">{HOME_FIGURES.map(item => <button key={item.id} onClick={() => goToSection('motifs', { motif: item.id, motif_candidates: null })}><span className="home-specimen-art"><img src={homeImage(`fig-${item.id}.png`)} alt={item.title} loading="lazy" /></span><strong>{item.title}</strong><small>{item.stone} · {item.place}</small></button>)}</div>
    </div></section>

    <section className="home-screen home-stage" data-screen="4" aria-label="武氏墓群石刻博物馆全景">
      <img className="home-stage-image" src={homeImage('court-aerial.jpg')} alt="武氏墓群石刻博物馆院落三维全景" loading="lazy" />
      <div className="home-stage-heading home-wrap"><h2><button onClick={() => onNavigate('scene')}>武氏墓群石刻博物馆全景<ArrowUpRight size={24} /></button></h2></div>
      <div className="home-screen-foot"><div className="home-wrap"><dl className="home-numbers">{AREAS.map(area => count(area, stats?.by_area[area], '件'))}</dl><button className="home-stage-enter" onClick={() => onNavigate('scene')} aria-label="进入院落三维全景"><ArrowRight size={26} /></button></div></div>
    </section>

    <section className="home-screen home-stage" data-screen="5" aria-label="武氏祠汉文化保护传承中心">
      <img className="home-stage-image" src={homeImage('center-aerial.jpg')} alt="武氏祠汉文化保护传承中心三维全景" loading="lazy" />
      <div className="home-stage-heading home-wrap"><h2><button onClick={() => onNavigate('center')}>武氏祠汉文化保护传承中心<ArrowUpRight size={24} /></button></h2></div>
      <div className="home-screen-foot"><div className="home-wrap"><dl className="home-numbers home-center-numbers"><div><dt>占地</dt><dd><em>约</em>4.47<small>公顷</small></dd></div><div><dt>建筑面积</dt><dd><em>约</em>17000<small>平方米</small></dd></div></dl><button className="home-stage-enter" onClick={() => onNavigate('center')} aria-label="进入传承中心三维场景"><ArrowRight size={26} /></button></div></div>
    </section>

    <section className="home-screen home-graph-section" data-screen="6" aria-label="知识图谱"><div className="home-wrap">
      {heading('知识图谱', '进入知识图谱', 'graph')}
      <div className="home-graph"><div><p>以画像石为线索，查看故事、人物与物象之间的联系，回查文献出处。</p><dl className="home-graph-numbers">{([['stone', '画像石'], ['story', '故事'], ['person', '人物'], ['object', '物象']] as const).map(([kind, name]) => <div key={kind}><dt><i style={{ background: COLORS[kind] }} />{name}</dt><dd>{number(summary.graph.meta.counts[kind])}</dd></div>)}{count('关联关系', summary.graph.meta.total_edges, '条')}{count('文献出处', summary.graph.meta.evidence_total, '条')}</dl><button className="home-go" onClick={() => onNavigate('graph')}>浏览知识图谱<ArrowRight size={16} /></button><small className="home-graph-note">文献候选关系，需结合原页与图像核对。</small></div>
        <figure className="home-graph-preview"><svg viewBox="0 0 690 440" role="img" aria-label="荆轲刺秦王的关联关系"><g className="home-graph-lines">{graphNodes.map(node => <line key={node.id} x1="345" y1="220" x2={node.x} y2={node.y} />)}</g>{graphNodes.map(node => <g key={node.id} className="home-graph-node" role="button" tabIndex={0} aria-label={`查看图谱节点${node.label}`} onClick={() => goToSection('graph', { kg_node: node.id, kg_stone: null })} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); goToSection('graph', { kg_node: node.id, kg_stone: null }) } }}><circle cx={node.x} cy={node.y} r={node.kind === 'stone' ? 13 : 9} fill={COLORS[node.kind]} /><text x={node.x} y={node.y + 28} textAnchor="middle">{node.label}</text></g>)}<g className="home-graph-hub"><circle cx="345" cy="220" r="27" fill={COLORS.story} /><text x="345" y="272" textAnchor="middle">荆轲刺秦王</text></g></svg><figcaption>荆轲刺秦王 · 关联关系</figcaption></figure>
      </div>
    </div></section>

    <footer className="home-footer"><div className="home-wrap home-footer-inner"><div className="home-footer-brand"><img src="/brand/culture-jining.png" alt="文化济宁" /><div><strong>嘉祥武氏墓群石刻</strong><span>数字档案与图像研究平台</span></div></div><div><h2>联系我们</h2><dl><dt>地址</dt><dd>山东省济宁市嘉祥县纸坊镇武翟山村</dd><dt>电话</dt><dd><a href="tel:05376987702">0537-6987702</a></dd><dt>邮箱</dt><dd><a href="mailto:jxww702@163.com">jxww702@163.com</a></dd></dl></div><div><h2>浏览平台</h2><button onClick={() => onNavigate('archive')}>文物档案</button><button onClick={() => onNavigate('stories')}>故事形象库</button><button onClick={() => onNavigate('creative')}>电子文创</button></div></div><p className="home-copyright">嘉祥县文物旅游服务中心 · 嘉祥武氏墓群石刻</p></footer>
  </div>
}
