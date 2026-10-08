import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, BookOpen, Download, ImageOff, LoaderCircle, Network, RefreshCw, Search, X } from 'lucide-react'
import { figureImageUrl, listStones, stoneAnnotations } from '../api'
import type { AnnotationReference, StoneNode } from '../types'
import CutoutImage from '../components/CutoutImage'
import ImageVersions from '../components/ImageVersions'
import { galleryImageVersionGroups, imageVersionLabel, preferredImageVersion } from '../lib/imageVersions'
import { useGalleryScroll } from '../lib/useGalleryScroll'
import { motifReferenceScope } from '../lib/motifCutouts'
import { collectStories, renderStoryCutout, storyConceptIds, storyProvenance, storyReferences, type StoryCutout, type StoryView } from '../lib/storyCutouts'
import { fetchKnowledgeGraph, type KnowledgeGraph } from '../lib/knowledgeGraph'
import { goToSection, openDocument } from '../lib/navigation'
import './motifLibrary.css'
import './storyLibrary.css'

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10000)
}
function openSource(ref: AnnotationReference) {
  if (!ref.document_id || !ref.page_no || ref.source_missing) return
  openDocument({ collection: 'core', documentId: ref.document_id, pageNo: ref.page_no, pageId: ref.page_id,
    segmentId: ref.segment_id, figureId: ref.figure_id })
}

function StoryDetail({ story, stories, onSelect, candidates, graph, graphError, retryGraph, close }: {
  story: StoryCutout; stories: StoryCutout[]; onSelect: (id: number) => void; candidates: boolean; graph: KnowledgeGraph | null; graphError: string; retryGraph: () => void; close: () => void
}) {
  const [view, setView] = useState<StoryView>('scene'), [image, setImage] = useState<Blob | null>(null)
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState('')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape); previous?.focus({ preventScroll: true }) }
  }, [story.annotation.id])
  const members = story.motifs.filter(m => candidates || m.annotation.review_status !== 'candidate')
  const activeView = view === 'composition' && !members.length ? 'scene' : view
  useEffect(() => { setImage(null) }, [activeView, candidates])
  const a = story.annotation, refs = storyReferences(story), ids = storyConceptIds(story)
  const segments = refs.filter(r => r.kind === 'segment'), figures = refs.filter(r => r.kind === 'figure')
  const linked = graph?.nodes.filter(n => n.concept_id != null && ids.has(n.concept_id)) || []
  const typology = motifReferenceScope(story) === 'typology'
  const name = `${story.stone.id}-${a.label.replace(/[\\/:*?"<>|]/g, '')}-${a.id}-${activeView}`
  async function download() {
    setDownloading(true); setDownloadError('')
    try { saveBlob(await renderStoryCutout(story, activeView, Infinity, candidates), name + '.png') }
    catch (reason) { setDownloadError((reason as Error).message) }
    finally { setDownloading(false) }
  }
  return <aside className="motif-detail story-detail" ref={panel} aria-label={`${a.label}的场景与关联`}>
    <header className="motif-detail-heading"><div><small>{story.stone.id} · {story.stone.name}</small><h2>{a.label}</h2></div><button onClick={close} aria-label="关闭故事详情"><X size={20} /></button></header>
    <div className="story-view-switch" role="group" aria-label="故事图像视图">
      <button aria-pressed={activeView === 'scene'} onClick={() => setView('scene')}>原图场景</button>
      <button aria-pressed={activeView === 'composition'} disabled={!members.length} onClick={() => setView('composition')}>形象组合</button>
    </div>
    <CutoutImage key={`${a.id}:${activeView}:${candidates}`} motif={story} large view={activeView} candidates={candidates} ready={setImage} />
    <p className="story-view-note">{activeView === 'scene' ? '保留原图中的人物、器物、刻线与相对位置。' : '已分割轮廓按原位置组合，未分出的部分留空。'}{a.atype === 'rect' && activeView === 'scene' && '此视图采用已标注的场景区域。'}</p>
    <div className="motif-downloads"><button disabled={!image || downloading} onClick={() => void download()}><Download size={15} />{downloading ? '正在生成原尺寸切图…' : `下载${activeView === 'scene' ? '故事场景' : '形象组合'}`}</button><button disabled={!image} onClick={() => saveBlob(new Blob([JSON.stringify(storyProvenance(story, activeView, candidates), null, 2)], { type: 'application/json' }), name + '-出处.json')}>保存出处</button></div>
    {downloadError && <p role="alert">{downloadError}</p>}
    <ImageVersions current={story} items={stories} onSelect={onSelect} />
    {a.review_status === 'candidate' && <p className="motif-candidate-note">候选场景：故事身份或现存形象仍有不确定性，原有说明一并保留。</p>}
    {typology && <p className="motif-reference-scope">类型参照：文献与插图用于比较同类题材，尚未确认是本石著录或书图。</p>}
    <section className="motif-detail-text"><h3>故事与图像</h3>{a.semantics.pre_iconographic && <p>{a.semantics.pre_iconographic}</p>}{a.semantics.iconographic && <p>{a.semantics.iconographic}</p>}{a.semantics.inscription.transcription && <p>{a.semantics.inscription.transcription}</p>}
      <details><summary>标注依据与释读说明</summary><p className="motif-note">{a.note}</p></details>
      <button className="motif-source-link" onClick={() => goToSection('archive', { stone: story.stone.id })}>查看原石档案<ArrowUpRight size={14} /></button>
    </section>
    <section className="motif-detail-text"><h3>故事中的形象与纹带 <span>{members.length}幅切图</span></h3>
      {!members.length ? <p>该场景的独立轮廓仍在整理；原图场景可供整体观察。{story.motifs.length > 0 && '勾选“包含候选场景与残片”可查看现存局部。'}</p> :
        <div className="story-member-grid">{members.map(m => <button key={m.annotation.id} onClick={() => goToSection('motifs', { motif: m.annotation.id, motif_candidates: m.annotation.review_status === 'candidate' ? '1' : null })} aria-label={`在画像形象库查看${m.annotation.label}`}><CutoutImage motif={m} /><span>{m.annotation.label}{m.annotation.review_status === 'candidate' && <small>候选残片</small>}</span></button>)}</div>}
    </section>
    <section className="motif-detail-text"><h3><BookOpen size={16} />{typology ? '类型参照文献' : '文献与书页插图'} <span>{segments.length}段 · {figures.length}幅</span></h3><p>以下文献来自本场景及所属形象的已保存关联。</p>
      {segments.map(ref => <details key={`s${ref.segment_id ?? ref.id}`} className="motif-reference"><summary>{ref.document_title || ref.document_code} · 第{ref.page_no}页{ref.source_missing ? '（出处已变化）' : ''}</summary><p>{ref.text}</p><button disabled={ref.source_missing} onClick={() => openSource(ref)}>阅读原书此段<ArrowUpRight size={13} /></button></details>)}
      <div className="motif-book-figures">{figures.map(ref => <button key={`f${ref.figure_id ?? ref.id}`} disabled={ref.source_missing || !ref.figure_id} onClick={() => openSource(ref)}>{ref.figure_id && !ref.source_missing && <img src={figureImageUrl(ref.figure_id)} alt={ref.figure_label || '原书插图'} loading="lazy" />}<span>{ref.document_code} · 第{ref.page_no}页 · {ref.figure_label || `插图 ${ref.figure_id}`}</span></button>)}</div>
    </section>
    <section className="motif-detail-text"><h3><Network size={16} />本场景的图谱关联</h3>{graphError ? <p>{graphError}<button onClick={retryGraph}>重试</button></p> : !graph ? <p>正在读取图谱…</p> : linked.length ? <div className="motif-graph-links">{linked.map(n => <button key={n.id} onClick={() => goToSection('graph', { kg_node: n.id, kg_stone: story.stone.id })}>{n.label}<ArrowUpRight size={13} /></button>)}</div> : <p>该场景的图谱关联仍在整理。</p>}
      <button className="motif-source-link" onClick={() => goToSection('graph', { kg_stone: story.stone.id, kg_node: null })}>查看本石故事与实体<ArrowUpRight size={14} /></button>
    </section>
  </aside>
}

export default function StoryLibraryPage() {
  const [stones, setStones] = useState<StoneNode[]>([]), [stories, setStories] = useState<StoryCutout[]>([])
  const [annotatedStones, setAnnotatedStones] = useState(0)
  const [loading, setLoading] = useState(true), [progress, setProgress] = useState(0), [errors, setErrors] = useState<string[]>([])
  const [reload, setReload] = useState(0), [query, setQuery] = useState('')
  const [stone, setStone] = useState(new URLSearchParams(location.hash.slice(1)).get('story_stone') || '')
  const [candidates, setCandidates] = useState(new URLSearchParams(location.hash.slice(1)).get('story_candidates') === '1'), [limit, setLimit] = useState(36)
  const [selected, setSelected] = useState(Number(new URLSearchParams(location.hash.slice(1)).get('story')) || 0)
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null), [graphError, setGraphError] = useState(''), [graphReload, setGraphReload] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)
  const rememberScroll = useGalleryScroll(scroll, selected)
  useEffect(() => {
    let active = true
    setLoading(true); setProgress(0); setErrors([]); setAnnotatedStones(0)
    void listStones().then(async rows => {
      if (!active) return
      setStones(rows)
      const result: StoryCutout[] = [], failures: string[] = []; let index = 0, completed = 0, annotated = 0
      async function work() {
        while (active && index < rows.length) {
          const item = rows[index++]
          try {
            const annotations = await stoneAnnotations(item.id)
            if (annotations.some(a => ['whole', 'layer', 'scene', 'band'].includes(a.level) && a.atype !== 'none' && ['reviewed', 'candidate', 'approved'].includes(a.review_status))) annotated++
            result.push(...collectStories(item, annotations))
          }
          catch (reason) { failures.push(`${item.id}：${(reason as Error).message}`) }
          completed++; if (active) setProgress(completed)
        }
      }
      await Promise.all(Array.from({ length: 4 }, work))
      if (!active) return
      result.sort((a, b) => a.stone.id.localeCompare(b.stone.id) || a.annotation.id - b.annotation.id)
      setStories(result); setErrors(failures); setAnnotatedStones(annotated)
    }).catch(reason => { if (active) setErrors([reason.message]) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [reload])
  useEffect(() => {
    const controller = new AbortController(); setGraphError('')
    void fetchKnowledgeGraph(controller.signal).then(setGraph).catch(reason => { if (!controller.signal.aborted) setGraphError(reason.message) })
    return () => controller.abort()
  }, [graphReload])
  useEffect(() => {
    const changed = () => {
      const params = new URLSearchParams(location.hash.slice(1))
      if (params.get('section') === 'stories') {
        setSelected(Number(params.get('story')) || 0); setStone(params.get('story_stone') || '')
      }
    }
    window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => { setLimit(36); scroll.current?.scrollTo(0, 0) }, [query, stone, candidates])
  const groups = useMemo(() => galleryImageVersionGroups(stories, candidates), [stories, candidates])
  const versionCount = groups.reduce((sum, group) => sum + group.versions.length, 0)
  const visible = useMemo(() => groups.filter(group => (!stone || group.representative.stone.id === stone) &&
    (!query.trim() || group.versions.some(s => [s.annotation.label, s.stone.id, s.stone.name, s.asset.filename, imageVersionLabel(s),
      ...s.descendants.map(a => a.label)].some(text => text.includes(query.trim()))))), [groups, stone, query])
  const selectedRecord = stories.find(s => s.annotation.id === selected)
  const current = selectedRecord && preferredImageVersion(selectedRecord, stories)
  const currentGroup = useMemo(() => current && galleryImageVersionGroups(stories, true)
    .find(group => group.versions.some(version => version.annotation.id === current.annotation.id))?.key, [stories, current])
  function select(id: number, anchor?: HTMLElement | null) {
    rememberScroll(anchor)
    setSelected(id)
    const hash = new URLSearchParams(location.hash.slice(1))
    if (id) hash.set('story', String(id)); else hash.delete('story')
    history.replaceState(null, '', '#' + hash)
  }
  function filterStone(value: string) {
    setStone(value)
    const hash = new URLSearchParams(location.hash.slice(1))
    if (value) hash.set('story_stone', value); else hash.delete('story_stone')
    hash.delete('story'); setSelected(0)
    history.replaceState(null, '', '#' + hash)
  }
  return <div className={`motif-library story-library${current ? ' has-detail' : ''}`}>
    <div className="motif-library-body" ref={scroll}>
      <header className="motif-intro"><div><p className="motif-eyebrow">整体观察 · 空间关系 · 出处可追溯</p><h1>故事形象库</h1><p>把人物、器物放回故事现场，观察动作、位置和彼此关系。由完整场景进入单体形象、文献与知识图谱。</p></div><div className="motif-library-count"><strong>{groups.length}</strong><span>个故事 · {new Set(groups.map(g => g.representative.stone.id)).size}件来源石</span><span>含不同版本共{versionCount}个切图</span><small>研究范围 {stones.length || '—'} 件 · {loading ? '正在读取标注' : `${annotatedStones}件有结构标注`}</small></div></header>
      <div className="motif-filters"><label className="motif-search"><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索故事、形象或石号" aria-label="搜索故事场景" /></label>
        <select value={stone} onChange={e => filterStone(e.target.value)} aria-label="筛选故事来源石件"><option value="">全部石件</option>{stones.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}</select>
        <label className="motif-candidate-toggle"><input type="checkbox" checked={candidates} onChange={e => setCandidates(e.target.checked)} />包含候选场景与残片</label>
        <button className="motif-refresh" disabled={loading} onClick={() => { setReload(v => v + 1); setGraphReload(v => v + 1) }} title="读取最新故事成果" aria-label="刷新故事形象库"><RefreshCw size={17} /></button>
      </div>
      {errors.length > 0 && <div className="motif-load-error" role="alert">{errors.length}项读取失败，当前结果可能不完整。<button onClick={() => setReload(v => v + 1)}>重试</button><details><summary>查看详情</summary>{errors.map(error => <p key={error}>{error}</p>)}</details></div>}
      {loading ? <div className="motif-state" role="status"><LoaderCircle size={22} />正在读取已标注场景… {progress}/{stones.length || '—'}</div> : <>
        <p className="motif-result-count">{visible.length}个故事（含不同版本共{visible.reduce((sum, g) => sum + g.versions.length, 0)}个切图）{candidates ? ' · 包含候选释读' : ''}</p>
        {!visible.length ? <div className="motif-state"><ImageOff size={26} /><p>当前范围暂无可展示的故事场景。</p><span>调整筛选，或查看候选场景。</span></div> :
          <div className="motif-grid story-grid">{visible.slice(0, limit).map(group => {
            const s = group.representative
            return <article key={group.key} className={`motif-card${group.key === currentGroup ? ' is-selected' : ''}`}><button className="motif-open" onClick={event => select(s.annotation.id, event.currentTarget.closest<HTMLElement>('.motif-card'))} aria-label={`查看故事场景${s.annotation.label}`}><CutoutImage motif={s} view="scene" /><div className="motif-card-caption"><small>{s.stone.id} · 原图场景</small><h2>{s.annotation.label}</h2><small className="motif-version-label">{imageVersionLabel(s)} · {group.versions.length}个图像版本</small><p>{s.stone.name}</p><span><BookOpen size={12} />{s.motifs.filter(m => candidates || m.annotation.review_status !== 'candidate').length}幅形象与纹带 · {storyReferences(s).filter(r => r.kind === 'segment').length}段文献{s.annotation.review_status === 'candidate' && <b>候选</b>}</span></div></button></article>
          })}</div>}
        {visible.length > limit && <button className="motif-more" onClick={() => setLimit(v => v + 36)}>继续显示故事（{limit}/{visible.length}）</button>}
      </>}
    </div>
    {current && <StoryDetail key={current.annotation.id} story={current} stories={stories} onSelect={select} candidates={candidates} graph={graph} graphError={graphError} retryGraph={() => setGraphReload(v => v + 1)} close={() => select(0)} />}
  </div>
}
