import { useEffect, useMemo, useRef, useState } from 'react'
import ImageVersions from '../components/ImageVersions'
import { galleryImageVersionGroups, imageVersionLabel, preferredImageVersion } from '../lib/imageVersions'
import { useGalleryScroll } from '../lib/useGalleryScroll'
import { ArrowUpRight, BookOpen, Download, ImageOff, LoaderCircle, Network, RefreshCw, Search, X } from 'lucide-react'
import { figureImageUrl } from '../api'
import type { AnnotationReference } from '../types'
import { collectMotifs, motifProvenance, motifReferenceScope, renderMotifCutout, type Motif } from '../lib/motifCutouts'
import { storiesOf } from '../lib/galleryCorpus'
import CutoutImage from '../components/CutoutImage'
import { loadKnowledgeGraph, type KnowledgeGraph } from '../lib/knowledgeGraph'
import { deriveByEntry, type AnnotationCorpus, type StoneAnnotations } from '../lib/publicCorpus'
import { useAnnotationCorpus } from '../lib/useAnnotationCorpus'
import { useAutoMore } from '../lib/useAutoMore'
import { matchesQuery } from '../lib/format'
import { goToSection, openDocument } from '../lib/navigation'
import './motifLibrary.css'

const CATEGORIES: Record<string, string> = {
  'figure-deity': '创世主神', 'figure-immortal': '仙人异士', 'figure-mythic-ruler': '帝王与圣贤',
  'figure-loyal-assassin': '忠臣义士', 'figure-filial-son': '孝子', 'figure-virtuous-woman': '烈女',
  'figure-music-dance': '乐舞百戏', 'chariot-procession': '车马出行', 'mythic-creature': '动物与神兽',
  celestial: '天象日月', 'daily-life-scene': '生活场景', architecture: '建筑', inscription: '题刻榜题',
  'pattern-border': '纹饰', unknown: '其他形象',
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10000)
}
function openSource(ref: AnnotationReference) {
  if (!ref.document_id || !ref.page_no || ref.source_missing) return
  openDocument({ collection: 'core', documentId: ref.document_id, pageNo: ref.page_no, pageId: ref.page_id,
    segmentId: ref.segment_id, figureId: ref.figure_id })
}

function MotifDetail({ motif, motifs, onSelect, storyIds, graph, graphError, retryGraph, close }: { motif: Motif; motifs: Motif[]; onSelect: (id: number) => void; storyIds: Set<number>; graph: KnowledgeGraph | null; graphError: string; retryGraph: () => void; close: () => void }) {
  const [image, setImage] = useState<Blob | null>(null)
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState('')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    setImage(null)
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape); previous?.focus({ preventScroll: true }) }
  }, [motif.annotation.id])
  const a = motif.annotation
  const refs = a.references.filter(ref => ref.kind === 'segment' || ref.kind === 'figure')
  const segments = refs.filter(ref => ref.kind === 'segment'), figures = refs.filter(ref => ref.kind === 'figure')
  const conceptIds = new Set([a, ...motif.ancestors].flatMap(node => node.concept_ids))
  const linked = graph?.nodes.filter(node => node.concept_id != null && conceptIds.has(node.concept_id)) || []
  const scene = motif.ancestors.find(parent => parent.level === 'scene')
  const typology = motifReferenceScope(motif) === 'typology'
  const name = `${motif.stone.id}-${a.label.replace(/[\\/:*?"<>|]/g, '')}-${a.id}`
  async function download() {
    setDownloading(true); setDownloadError('')
    try { saveBlob(await renderMotifCutout(motif, Infinity), name + '.png') }
    catch (reason) { setDownloadError((reason as Error).message) }
    finally { setDownloading(false) }
  }
  return <aside className="motif-detail" ref={panel} aria-label={`${a.label}的出处与关联`}>
    <header className="motif-detail-heading"><div><small>{motif.stone.id} · {motif.stone.name}</small><h2>{a.label}</h2></div><button onClick={close} aria-label="关闭形象详情"><X size={20} /></button></header>
    <CutoutImage key={a.id} motif={motif} large ready={setImage} />
    <div className="motif-downloads"><button disabled={!image || downloading} onClick={() => void download()}><Download size={15} />{downloading ? '正在生成原尺寸切图…' : '下载透明切图'}</button><button disabled={!image} onClick={() => saveBlob(new Blob([JSON.stringify(motifProvenance(motif), null, 2)], { type: 'application/json' }), name + '-出处.json')}>保存出处</button></div>
    {downloadError && <p role="alert">{downloadError}</p>}
    <ImageVersions current={motif} items={motifs} onSelect={onSelect} />
    {a.review_status === 'candidate' && <p className="motif-candidate-note">候选形象：局部边界或身份解释仍有不确定性。</p>}
    {typology && <p className="motif-reference-scope">类型参照：所附文献与插图用于比较同类形象，尚未确认是本石的著录或书图。</p>}
    <section className="motif-detail-text"><h3>图像释读</h3>{a.semantics.pre_iconographic && <p>{a.semantics.pre_iconographic}</p>}{a.semantics.iconographic && <p>{a.semantics.iconographic}</p>}{a.semantics.inscription.transcription && <p className="motif-transcription">{a.semantics.inscription.transcription}</p>}{scene && <small>所属场景：{scene.label}</small>}
      <details><summary>标注依据与释读说明</summary><p className="motif-note">{a.note}</p>{a.semantics.inscription.notes && <p>{a.semantics.inscription.notes}</p>}</details>
      <button className="motif-source-link" onClick={() => goToSection('archive', { stone: motif.stone.id })}>查看原石档案<ArrowUpRight size={14} /></button>
      {motif.ancestors.filter(parent => storyIds.has(parent.id)).map(parent => <button key={parent.id} className="motif-source-link motif-story-link" onClick={() => goToSection('stories', { story: parent.id, story_stone: motif.stone.id, story_candidates: a.review_status === 'candidate' ? '1' : null })}>查看完整故事场景：{parent.label}<ArrowUpRight size={14} /></button>)}
    </section>
    <section className="motif-detail-text"><h3><BookOpen size={16} />{typology ? '类型参照文献' : '文献出处'} <span>{segments.length} 段 · {figures.length} 幅插图</span></h3>
      {segments.map(ref => <details key={ref.id} className="motif-reference"><summary>{ref.document_title || ref.document_code} · 第{ref.page_no}页{ref.source_missing ? '（出处已变化）' : ''}</summary><p>{ref.text}</p><button disabled={ref.source_missing} onClick={() => openSource(ref)}>阅读原书此段<ArrowUpRight size={13} /></button></details>)}
      <div className="motif-book-figures">{figures.map(ref => <button key={ref.id} disabled={ref.source_missing || !ref.figure_id} onClick={() => openSource(ref)}>{ref.figure_id && !ref.source_missing && <img src={figureImageUrl(ref.figure_id)} alt={ref.figure_label || '原书插图'} loading="lazy" />}<span>{ref.document_code} · 第{ref.page_no}页 · {ref.figure_label || `插图 ${ref.figure_id}`}</span></button>)}</div>
    </section>
    <section className="motif-detail-text"><h3><Network size={16} />知识图谱</h3>{graphError ? <p>{graphError}<button onClick={retryGraph}>重试</button></p> : !graph ? <p>正在读取图谱…</p> : linked.length ? <div className="motif-graph-links">{linked.map(node => <button key={node.id} onClick={() => goToSection('graph', { kg_node: node.id, kg_stone: motif.stone.id })}>{node.label}<ArrowUpRight size={13} /></button>)}</div> : <p>该形象的图谱关联仍在整理。</p>}
      <button className="motif-source-link" onClick={() => goToSection('graph', { kg_stone: motif.stone.id, kg_node: null })}>查看本石故事与实体<ArrowUpRight size={14} /></button>
    </section>
  </aside>
}

const motifsByEntry = new WeakMap<StoneAnnotations, { motifs: Motif[]; storyIds: number[] }>()
function deriveMotifLibrary(corpus: AnnotationCorpus) {
  const motifs: Motif[] = [], storyIds = new Set<number>()
  for (const entry of corpus.entries) {
    const derived = deriveByEntry(motifsByEntry, entry, ({ stone, annotations }) => ({
      motifs: collectMotifs(stone, annotations),
      storyIds: storiesOf(entry).map(story => story.annotation.id),
    }))
    motifs.push(...derived.motifs)
    derived.storyIds.forEach(id => storyIds.add(id))
  }
  motifs.sort((a, b) => a.stone.id.localeCompare(b.stone.id) || a.annotation.id - b.annotation.id)
  return { motifs, storyIds }
}
const NO_MOTIFS: Motif[] = [], NO_STORIES = new Set<number>()

export default function MotifLibraryPage() {
  const [reload, setReload] = useState(0), [query, setQuery] = useState(''), [stone, setStone] = useState(''), [category, setCategory] = useState('')
  // 近期读取过的标注直接复用；第一次读取时先显示已读到的石件
  const corpus = useAnnotationCorpus(reload, deriveMotifLibrary)
  const { stones, errors, annotatedStones, loading, done: progress, total } = corpus
  const motifs = corpus.value?.motifs ?? NO_MOTIFS, storyIds = corpus.value?.storyIds ?? NO_STORIES
  const [candidates, setCandidates] = useState(new URLSearchParams(location.hash.slice(1)).get('motif_candidates') === '1'), [limit, setLimit] = useState(48)
  const [selected, setSelected] = useState(Number(new URLSearchParams(location.hash.slice(1)).get('motif')) || 0)
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null), [graphError, setGraphError] = useState(''), [graphReload, setGraphReload] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)
  const rememberScroll = useGalleryScroll(scroll, selected)
  const moreRef = useAutoMore(scroll, limit, () => setLimit(value => value + 48))
  useEffect(() => {
    const controller = new AbortController(); setGraphError('')
    void loadKnowledgeGraph({ force: graphReload > 0, signal: controller.signal }).then(setGraph).catch(reason => { if (!controller.signal.aborted) setGraphError(reason.message) })
    return () => controller.abort()
  }, [graphReload])
  useEffect(() => {
    const changed = () => { if (new URLSearchParams(location.hash.slice(1)).get('section') === 'motifs') setSelected(Number(new URLSearchParams(location.hash.slice(1)).get('motif')) || 0) }
    window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => { setLimit(48); scroll.current?.scrollTo(0, 0) }, [query, stone, category, candidates])
  const groups = useMemo(() => galleryImageVersionGroups(motifs, candidates), [motifs, candidates])
  const versionCount = groups.reduce((sum, group) => sum + group.versions.length, 0)
  const visible = useMemo(() => groups.filter(group => (!stone || group.representative.stone.id === stone) &&
    (!category || group.versions.some(m => m.annotation.category === category)) &&
    (!query.trim() || group.versions.some(motif => matchesQuery(query, [motif.annotation.label, motif.stone.id, motif.stone.name, motif.asset.filename, imageVersionLabel(motif), CATEGORIES[motif.annotation.category], ...motif.ancestors.map(node => node.label)])))), [groups, stone, category, query])
  const selectedRecord = motifs.find(motif => motif.annotation.id === selected)
  const current = selectedRecord && preferredImageVersion(selectedRecord, motifs)
  const currentGroup = useMemo(() => current && galleryImageVersionGroups(motifs, true)
    .find(group => group.versions.some(version => version.annotation.id === current.annotation.id))?.key, [motifs, current])
  const categories = [...new Set(motifs.map(motif => motif.annotation.category))].sort()
  function select(id: number, anchor?: HTMLElement | null) {
    rememberScroll(anchor)
    setSelected(id)
    const hash = new URLSearchParams(location.hash.slice(1))
    if (id) hash.set('motif', String(id)); else hash.delete('motif')
    history.replaceState(null, '', '#' + hash)
  }
  return <div className={`motif-library${current ? ' has-detail' : ''}`}>
    <div className="motif-library-body" ref={scroll}>
      <header className="motif-intro"><div><p className="motif-eyebrow">原图切割 · 出处可追溯</p><h1>画像形象库</h1><p>独立浏览石上的人物、动物、车马与纹饰。每幅形象连接原石、文献和知识图谱。</p></div><div className="motif-library-count"><strong>{groups.length}</strong><span>个形象 · {new Set(groups.map(g => g.representative.stone.id)).size}件来源石</span><span>含不同版本共{versionCount}个切图</span><small>研究范围 {stones.length || total || '—'} 件 · {loading ? '正在读取标注' : `${annotatedStones}件有结构标注`}</small></div></header>
      <div className="motif-filters"><label className="motif-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索形象、故事或石号" aria-label="搜索形象" /></label>
        <select value={stone} onChange={event => setStone(event.target.value)} aria-label="筛选来源石件"><option value="">全部石件</option>{stones.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name}</option>)}</select>
        <select value={category} onChange={event => setCategory(event.target.value)} aria-label="筛选形象类别"><option value="">全部类别</option>{categories.map(key => <option key={key} value={key}>{CATEGORIES[key] || '其他形象'}</option>)}</select>
        <label className="motif-candidate-toggle"><input type="checkbox" checked={candidates} onChange={event => setCandidates(event.target.checked)} />包含候选残片</label>
        <button className="motif-refresh" disabled={loading} onClick={() => { setReload(value => value + 1); setGraphReload(value => value + 1) }} title="读取最新标注成果" aria-label="刷新形象库"><RefreshCw size={17} /></button>
      </div>
      {errors.length > 0 && <div className="motif-load-error" role="alert">{errors.length}项读取失败，当前结果可能不完整。<button onClick={() => setReload(value => value + 1)}>重试</button><details><summary>查看详情</summary>{errors.map(error => <p key={error}>{error}</p>)}</details></div>}
      {loading && !motifs.length ? <div className="motif-state" role="status"><LoaderCircle size={22} />正在读取已标注成果… {progress}/{total || stones.length || '—'}</div> : <>
        <p className="motif-result-count">{visible.length}个形象（含不同版本共{visible.reduce((sum, g) => sum + g.versions.length, 0)}个切图）{candidates ? ' · 包含候选残片' : ''}{loading && <span className="motif-loading-more" role="status"><LoaderCircle size={13} />继续读取 {progress}/{total || '—'} 件石刻</span>}</p>
        {!visible.length ? loading ? <div className="motif-state" role="status"><LoaderCircle size={22} />正在读取其余石刻…</div> : <div className="motif-state"><ImageOff size={26} /><p>当前范围暂无可展示的独立切图。</p><span>{query || stone || category ? '调整筛选条件试试。' : '已标注成果正在按石件逐步收录。'}</span>{(query || stone || category) && <button className="motif-clear" onClick={() => { setQuery(''); setStone(''); setCategory('') }}>清除筛选</button>}</div> :
          <div className="motif-grid">{visible.slice(0, limit).map(group => {
            const motif = group.representative
            return <article key={group.key} className={`motif-card${group.key === currentGroup ? ' is-selected' : ''}`}><button className="motif-open" onClick={event => select(motif.annotation.id, event.currentTarget.closest<HTMLElement>('.motif-card'))} aria-label={`查看${motif.annotation.label}的出处`}><CutoutImage motif={motif} /><div className="motif-card-caption"><small>{motif.stone.id} · {CATEGORIES[motif.annotation.category] || '形象'}</small><h2>{motif.annotation.label}</h2><small className="motif-version-label">{imageVersionLabel(motif)} · {group.versions.length}个图像版本</small><p>{motif.ancestors.find(node => node.level === 'scene')?.label || motif.stone.name}</p><span><BookOpen size={12} />{motif.annotation.references.filter(ref => ref.kind === 'segment').length}段文献{motif.annotation.review_status === 'candidate' && <b>候选</b>}</span></div></button></article>
          })}</div>}
        {visible.length > limit && <button ref={moreRef} className="motif-more" onClick={() => setLimit(value => value + 48)}>继续显示形象（{limit}/{visible.length}）</button>}
      </>}
    </div>
    {current && <MotifDetail key={current.annotation.id} motif={current} motifs={motifs} onSelect={select} storyIds={storyIds} graph={graph} graphError={graphError} retryGraph={() => setGraphReload(value => value + 1)} close={() => select(0)} />}
  </div>
}
