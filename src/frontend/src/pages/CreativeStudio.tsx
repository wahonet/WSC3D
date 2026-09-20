import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, Eye, EyeOff, Film, ImagePlus, Plus, X } from 'lucide-react'
import VideoPage from './VideoPage'
import ImageGeneration from './ImageGeneration'
import AnnotationSourcePicker, { emptySelection, type AnnotationSelection } from '../components/AnnotationSourcePicker'
import { creativeApi, newDesign, type Design, type Material, type Template } from '../lib/creativeApi'
import { videoApi, type VideoJob } from '../lib/videoApi'
import { goToSection } from '../lib/navigation'
import { Sources } from './CreativePage'
import './CreativePage.css'

type Tab = 'video' | 'images' | 'materials'
function initialTab(): Tab { const q = new URLSearchParams(location.hash.slice(1)); return q.has('video_nodes') ? 'video' : q.get('creative_tab') === 'templates' ? 'materials' : (['video', 'images', 'materials'].includes(q.get('creative_tab') || '') ? q.get('creative_tab') as Tab : 'video') }
function initialPublicationView() { const q = new URLSearchParams(location.hash.slice(1)); return q.get('creative_tab') === 'templates' || q.get('creative_view') === 'templates' ? 'templates' : 'materials' }

function TemplateCard({ template, materials, onSaved }: { template: Template; materials: Material[]; onSaved: () => void }) {
  const initial = materials.find(m => m.id === template.design?.layers[0]?.material_id) || materials.find(m => (template.video || m.kind === 'image') && (template.id !== 'sticker' || m.has_ink))
  const [design, setDesign] = useState<Design | null>(template.design || (initial ? newDesign(template, initial) : null))
  const [published, setPublished] = useState(template.published), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const save = async () => { if (!design) return; setBusy(true); setMessage(''); try { await creativeApi.saveTemplate(template.id, published, design); setMessage('已保存'); onSaved() } catch (reason) { setMessage((reason as Error).message) } finally { setBusy(false) } }
  return <article className="creative-template-config"><h3>{template.category}</h3>{design && <>
    <label>示例素材<select value={design.layers[0]?.material_id} onChange={event => { const m = materials.find(m => m.id === event.target.value); if (m) setDesign({ ...design, layers: newDesign(template, m).layers }) }}>{materials.filter(m => (template.video || m.kind === 'image') && (template.id !== 'sticker' || m.has_ink)).map(m => <option key={m.id} value={m.id}>{m.title}{m.published ? '' : '（未发布）'}</option>)}</select></label>
    <label>标题<input maxLength={18} value={design.title} onChange={event => setDesign({ ...design, title: event.target.value })} /></label><label>寄语<input maxLength={48} value={design.greeting} onChange={event => setDesign({ ...design, greeting: event.target.value })} /></label>
    <label>配色<select value={design.palette} onChange={event => setDesign({ ...design, palette: event.target.value as Design['palette'] })}><option value="cinnabar">朱砂</option><option value="jade">青玉</option><option value="midnight">星夜</option><option value="white">墨白</option></select></label>
  </>}<label className="creative-checkbox"><input type="checkbox" checked={published} onChange={event => setPublished(event.target.checked)} />对访客开放</label><button className="creative-button" disabled={busy || !design} onClick={() => void save()}>保存版式</button>{message && <span role="status">{message}</span>}</article>
}

export default function CreativeStudio() {
  const [tab, setTab] = useState<Tab>(initialTab), [materials, setMaterials] = useState<Material[]>([]), [templates, setTemplates] = useState<Template[]>([])
  const [selected, setSelected] = useState<Material | null>(null), [title, setTitle] = useState(''), [tags, setTags] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState<'annotations' | 'video' | null>(null)
  const [videos, setVideos] = useState<VideoJob[]>([]), [importSelection, setImportSelection] = useState<AnnotationSelection>(emptySelection)
  const [imageMaterial, setImageMaterial] = useState(''), [publicationView, setPublicationView] = useState(initialPublicationView)
  const reload = async () => { const [m, t] = await Promise.all([creativeApi.materials(), creativeApi.templates()]); setMaterials(m); setTemplates(t) }
  useEffect(() => {
    void reload().catch(reason => setError(reason.message))
    const onHash = () => { setTab(initialTab()); setPublicationView(initialPublicationView()) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const changeTab = (next: Tab) => { setTab(next); setError(''); setPublicationView('materials'); goToSection('video', { creative_tab: next, creative_view: null, video_nodes: null }) }
  const changePublicationView = (next: string) => { setPublicationView(next); goToSection('video', { creative_tab: 'materials', creative_view: next === 'templates' ? 'templates' : null, video_nodes: null }) }
  const choose = (m: Material) => { setSelected(m); setTitle(m.title); setTags(m.tags.join('、')) }
  const saveMaterial = async (published: boolean) => {
    if (!selected) return
    setBusy(true); setError('')
    try { const value = await creativeApi.publish(selected.id, published, title, tags.split(/[、,，]/).map(v => v.trim()).filter(Boolean)); choose(value); await reload() }
    catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  const openImport = async (kind: 'annotations' | 'video') => {
    setError(''); setImporting(kind)
    try { if (kind === 'annotations') setImportSelection(emptySelection); else setVideos((await videoApi.jobs()).filter(v => v.status === 'succeeded')) }
    catch (reason) { setError((reason as Error).message) }
  }
  const importMaterial = async (videoId?: string) => {
    setBusy(true); setError('')
    try { const value = videoId ? await creativeApi.importVideo(videoId) : await creativeApi.importAnnotations(importSelection.annotation_ids); choose(value); await reload(); setImporting(null) }
    catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  return <div className="creative-studio"><div className="creative-studio-tabs" role="tablist" aria-label="电子文创工作台">{([['video', '视频生成'], ['images', '图像生成'], ['materials', '素材发布']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => { setImageMaterial(''); changeTab(key) }}>{label}</button>)}<span /><button onClick={() => goToSection('creative', { share: null })}>查看展示页<ArrowUpRight size={14} /></button></div>
    {error && <div className="creative-error creative-page-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {tab === 'video' ? <VideoPage /> : tab === 'images' ? <ImageGeneration materials={materials} initialMaterialId={imageMaterial} onMaterialsChanged={reload} onPublish={m => { choose(m); changeTab('materials') }} /> : <div className="creative-studio-body">
      <div className="creative-publication-tabs" role="tablist" aria-label="素材发布设置"><button role="tab" aria-selected={publicationView === 'materials'} onClick={() => changePublicationView('materials')}>素材库</button><button role="tab" aria-selected={publicationView === 'templates'} onClick={() => changePublicationView('templates')}>版式调整</button></div>
      {publicationView === 'materials' && <><div className="creative-studio-heading"><h1>素材发布</h1><div><button className="creative-button" onClick={() => void openImport('annotations')}><Plus size={16} />从标注导入</button><button className="creative-button" onClick={() => void openImport('video')}><Film size={16} />从视频导入</button></div></div>
        <div className={'creative-curation'+(selected ? ' has-detail' : '')}><div className="creative-curation-grid">{materials.map(m => <button key={m.id} className={selected?.id === m.id ? 'selected' : ''} onClick={() => choose(m)}><img src={m.thumb_url} alt="" /><span><strong>{m.title}</strong><small>{m.kind === 'video' ? '视频' : m.origin === 'seedream' ? 'Seedream' : '标注图案'} · {m.published ? '已发布' : '未发布'}</small></span></button>)}</div>
          {selected && <aside className="creative-material-detail"><div className="creative-panel-title"><h2>素材</h2><button aria-label="关闭素材详情" onClick={() => setSelected(null)}><X size={16} /></button></div>{selected.video_url ? <video src={selected.video_url} poster={selected.image_url} controls playsInline /> : <img src={selected.image_url} alt={selected.title} />}
            <label>名称<input maxLength={80} value={title} onChange={event => setTitle(event.target.value)} /></label><label>标签<input value={tags} onChange={event => setTags(event.target.value)} placeholder="用顿号分隔" /></label><div className="creative-publish-actions"><button className="creative-primary" disabled={busy} onClick={() => void saveMaterial(true)}>{selected.published ? <Check size={15} /> : <Eye size={15} />}{selected.published ? '保存修改' : '发布素材'}</button>{selected.published && <button className="creative-button" disabled={busy} onClick={() => void saveMaterial(false)}><EyeOff size={14} />下架</button>}</div>
            <button className="creative-button" onClick={() => { setImageMaterial(selected.id); changeTab('images') }}><ImagePlus size={15} />生成彩色衍生图</button><Sources items={[selected]} /></aside>}
        </div></>}
      {publicationView === 'templates' && <><div className="creative-studio-heading"><h1>版式调整</h1></div><div className="creative-template-config-grid">{templates.map(t => <TemplateCard key={t.id} template={t} materials={materials} onSaved={() => void reload()} />)}</div></>}
    </div>}
    {importing && <div className="creative-modal-backdrop" onClick={() => { if (!busy) setImporting(null) }}><section className="creative-import-dialog" role="dialog" aria-modal="true" aria-label={importing === 'video' ? '导入视频' : '导入标注'} onClick={event => event.stopPropagation()}><header><h2>{importing === 'video' ? '导入视频' : '导入标注图案'}</h2><button disabled={busy} aria-label="关闭导入" onClick={() => setImporting(null)}><X size={20} /></button></header>
      {importing === 'annotations' ? <><AnnotationSourcePicker value={importSelection} onChange={setImportSelection} disabled={busy} /><button className="creative-primary" disabled={busy || !importSelection.annotation_ids.length} onClick={() => void importMaterial()}>{busy ? '导出图案中…' : '加入素材库'}</button></>
        : <div className="creative-import-videos">{videos.map(v => <button key={v.id} disabled={busy} onClick={() => void importMaterial(v.id)}><img src={v.poster_url || ''} alt="" /><span>{v.title}</span><Plus size={18} /></button>)}</div>}
    </section></div>}
  </div>
}
