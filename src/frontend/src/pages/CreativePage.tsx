import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ArrowUpRight, BookOpen, Check, Download, Film, ImagePlus, Layers, LoaderCircle, Palette, Plus, Search, Share2, X } from 'lucide-react'
import { creativeApi, newDesign, type Catalogue, type Design, type Layer, type Material, type Preview, type Template, type Work } from '../lib/creativeApi'
import { goToSection, openDocument } from '../lib/navigation'
import './CreativePage.css'

const draftKey = 'wsc.creative.design.v1'
function storedDesign(): Design | null { try { return JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { return null } }
function shareUrl(token: string) { return location.origin + '/#section=creative&share=' + encodeURIComponent(token) }

export function Sources({ items }: { items: Material[] }) {
  const unique = [...new Map(items.map(item => [item.id, item])).values()]
  return <details className="creative-sources"><summary><BookOpen size={15} />原石与文献</summary>{unique.map(item => <div key={item.id}>
    {item.source.stone_id && <button onClick={() => goToSection('archive', { stone: item.source.stone_id, share: null })}>{item.source.stone_id} · {item.source.stone_name}<ArrowUpRight size={14} /></button>}
    {(item.source.references || []).filter(ref => ref.document_id && ref.page_no).map((ref, i) => <button key={i} onClick={() => openDocument({ collection: 'core', documentId: ref.document_id, pageNo: ref.page_no })}>{ref.document_title} · 第 {ref.page_no} 页<ArrowUpRight size={12} /></button>)}
    {!item.source.stone_id && !item.source.references?.length && <span>{item.title} · 汉画启发创作</span>}
  </div>)}</details>
}

function Result({ work, onUpdate, shared = false }: { work: Work; onUpdate: (work: Work) => void; shared?: boolean }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const share = async (enabled = true) => {
    setBusy(true); setError('')
    try { onUpdate(await creativeApi.share(work.id, enabled)) } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  if (work.status === 'rendering') return <div className="creative-result" role="status"><LoaderCircle className="creative-spin" size={17} />正在导出…</div>
  if (work.status !== 'succeeded') return <div className="creative-error" role="alert">{work.error || '导出未完成'}</div>
  return <div className="creative-result">
    <div className="creative-downloads"><a href={work.image_url} download={`${work.design.title || '汉画'}.png`}><Download size={15} />{work.video_url ? '封面 PNG' : '下载 PNG'}</a>
      {work.video_url && <a href={work.video_url} download={`${work.design.title || '汉画'}.mp4`}><Film size={15} />下载视频</a>}
      {!shared && <button disabled={busy} onClick={() => void share()}><Share2 size={15} />分享作品</button>}</div>
    {work.share && !shared && <div className="creative-share-link"><input aria-label="作品分享链接" readOnly value={shareUrl(work.share)} onFocus={event => event.target.select()} />
      <button onClick={() => void navigator.clipboard.writeText(shareUrl(work.share!)).catch(() => setError('请选中链接复制'))}>复制</button><button disabled={busy} onClick={() => void share(false)}>取消分享</button></div>}
    {error && <span className="creative-error" role="alert">{error}</span>}
  </div>
}

export default function CreativePage() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  const [design, setDesign] = useState<Design | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState(''), [kind, setKind] = useState('all')
  const [selected, setSelected] = useState(0), [adding, setAdding] = useState(false)
  const [work, setWork] = useState<Work | null>(null), [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<Work[] | null>(null)
  const [shared, setShared] = useState<Work | null>(null), [sharedToken, setSharedToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('share') || '')
  const [resume, setResume] = useState<Design | null>(storedDesign)
  const requestRef = useRef<{ id: string; key: string } | null>(null)
  const submitLock = useRef(false), drag = useRef<{ x: number; y: number; original: Layer } | null>(null)
  const previewArea = useRef<HTMLDivElement>(null)
  useEffect(() => { creativeApi.catalogue().then(setCatalogue).catch(reason => setError(reason.message)) }, [])
  useEffect(() => {
    const changed = () => setSharedToken(new URLSearchParams(location.hash.slice(1)).get('share') || '')
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    let current = true
    setShared(null)
    if (sharedToken) creativeApi.shared(sharedToken).then(value => { if (current) setShared(value) }).catch(reason => { if (current) setError(reason.message) })
    return () => { current = false }
  }, [sharedToken])
  const designKey = JSON.stringify(design)
  useEffect(() => {
    if (!design) { setPreview(null); return }
    const controller = new AbortController()
    setPreviewBusy(true); setError('')
    try { localStorage.setItem(draftKey, JSON.stringify(design)) } catch { /* The current composition still works without storage. */ }
    const timer = window.setTimeout(() => creativeApi.preview(design, controller.signal).then(value => { if (!controller.signal.aborted) setPreview(value) })
      .catch(reason => { if (!controller.signal.aborted) { setError(reason.message); setPreview(null) } }).finally(() => { if (!controller.signal.aborted) setPreviewBusy(false) }), 250)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [designKey])
  useEffect(() => {
    if (work?.status !== 'rendering') return
    let current = true, loading = false
    const timer = window.setInterval(() => {
      if (loading) return
      loading = true
      creativeApi.work(work.id).then(value => { if (current) setWork(value) }).catch(reason => { if (current) setError(reason.message) }).finally(() => { loading = false })
    }, 2000)
    return () => { current = false; window.clearInterval(timer) }
  }, [work?.id, work?.status])

  const patch = (value: Partial<Design>) => { setDesign(old => old && ({ ...old, ...value })); setWork(null) }
  const patchLayer = (value: Partial<Layer>) => { if (design) patch({ layers: design.layers.map((layer, i) => i === selected ? { ...layer, ...value } : layer) }) }
  const chooseTemplate = (template: Template) => {
    if (!catalogue) return
    const starter = template.design?.layers.every(l => catalogue.materials.some(m => m.id === l.material_id)) ? template.design : undefined
    const material = catalogue.materials.find(m => (template.video || m.kind === 'image') && (template.id !== 'sticker' || m.has_ink))
    if (!material && !starter) { setError('暂无可用素材'); return }
    setDesign(starter ? { ...starter, signature: '' } : newDesign(template, material!)); setWork(null); setSelected(0); setAdding(false); setKind('all'); setFilter(''); setError('')
    if (sharedToken) goToSection('creative', { share: null })
  }
  const selectMaterial = (material: Material) => {
    if (!design) return
    if (design.template === 'sticker' && !material.has_ink) { setError('透明贴纸请选择标注图案'); return }
    if (material.kind === 'video' && design.template !== 'postcard') { setError('请先选择动态明信片版式'); return }
    if (adding && design.layers.length < 3 && material.kind !== 'video') {
      patch({ layers: [...design.layers, { material_id: material.id, x: 72, y: 70, scale: .4, tint: material.has_ink }] }); setSelected(design.layers.length)
    } else { patch({ layers: [{ material_id: material.id, x: 50, y: 50, scale: 1, tint: design.template === 'sticker' }] }); setSelected(0) }
    setAdding(false); setError('')
  }
  const exportWork = async () => {
    if (!design || submitLock.current || previewBusy || !preview) return
    submitLock.current = true; setBusy(true); setError('')
    if (requestRef.current?.key !== designKey) requestRef.current = { id: crypto.randomUUID(), key: designKey }
    try { const result = await creativeApi.create(requestRef.current!.id, design); setWork(result); if (result.status === 'failed') requestRef.current = null }
    catch (reason) { setError((reason as Error).message) }
    finally { submitLock.current = false; setBusy(false) }
  }
  const showHistory = async () => { try { setHistory(await creativeApi.works()) } catch (reason) { setError((reason as Error).message) } }
  const selectedMaterial = catalogue?.materials.find(item => item.id === design?.layers[selected]?.material_id)
  const chosen = design?.layers.map(layer => catalogue?.materials.find(item => item.id === layer.material_id)).filter((item): item is Material => !!item) || []
  const filtered = catalogue?.materials.filter(m => (kind === 'all' || m.kind === kind) && (design?.template === 'postcard' || m.kind !== 'video') && (design?.template !== 'sticker' || m.has_ink) && [m.title, ...m.tags].some(value => value.includes(filter))) || []

  return <div className="creative-page">
    <header className="creative-heading"><div>{design && !sharedToken && <button className="creative-back" onClick={() => { setResume(design); setDesign(null); setWork(null) }}><ArrowLeft size={16} />全部版式</button>}<h1>电子文创</h1></div><button className="creative-button" onClick={() => void showHistory()}><Layers size={16} />我的作品</button></header>
    {error && <div className="creative-error creative-page-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}><X size={14} /></button></div>}
    {sharedToken ? shared ? <div className="creative-shared"><div className="creative-shared-art">{shared.video_url ? <video src={shared.video_url} poster={shared.cover_url} controls playsInline loop /> : <img src={shared.image_url} alt={shared.design.title} />}</div><div><h2>{shared.design.title}</h2>{shared.design.signature && <p>{shared.design.signature} 的汉画作品</p>}<Result work={shared} onUpdate={setShared} shared /><button className="creative-primary" onClick={() => { setDesign(shared.design); setWork(null); goToSection('creative', { share: null }) }}>制作我的版本<ArrowUpRight size={16} /></button><Sources items={shared.sources} /></div></div> : <div className="creative-empty">{error ? '此分享暂不可用' : '正在打开作品…'}</div>
    : !design ? <main className="creative-gallery"><div className="creative-gallery-title"><h2>把汉画带走</h2>{resume && <button className="creative-button" onClick={() => { setDesign(resume); setResume(null) }}>继续上次创作<ArrowUpRight size={15} /></button>}</div>
      <div className="creative-template-grid">{catalogue?.templates.map((template, index) => <button className={'creative-template creative-template-'+template.id} key={template.id} onClick={() => chooseTemplate(template)}><div className="creative-template-art"><>{template.cover_url ? <img src={template.cover_url} alt={template.category+'成品示例'} /> : <ImagePlus size={48} />}</><span className="creative-template-number">0{index+1}</span></div><div className="creative-template-caption"><span><small>{template.category}</small><strong>{template.title}</strong></span><ArrowUpRight size={22} /></div></button>)}</div>
      {catalogue && !catalogue.templates.length && <div className="creative-empty">版式准备中</div>}
      <div className="creative-collection-heading"><h3>从一个形象开始</h3><span>汉画图案 · 动态故事</span></div><div className="creative-inspiration">{catalogue?.materials.slice(0, 12).map(item => <button key={item.id} onClick={() => { const template = catalogue.templates.find(t => t.id === (item.kind === 'video' ? 'postcard' : 'card')); if (template) { setDesign(newDesign(template, item)); setSelected(0) } }}><img src={item.thumb_url} alt="" loading="lazy" /><span>{item.title}{item.kind === 'video' && <Film size={13} />}</span></button>)}</div>
    </main> : <main className="creative-editor">
      <aside className="creative-material-panel"><div className="creative-panel-title"><h2>选素材</h2><button className={adding ? 'active' : ''} aria-pressed={adding} disabled={design.layers.length >= 3} onClick={() => setAdding(!adding)}><Plus size={14} />叠加图案</button></div>
        <label className="creative-search"><Search size={15} /><input aria-label="搜索文创素材" value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索形象、故事" /></label>
        <div className="creative-filter">{[['all', '全部'], ['image', '图案'], ['video', '视频']].filter(([key]) => design.template === 'postcard' || key !== 'video').map(([key, label]) => <button key={key} className={kind === key ? 'active' : ''} onClick={() => setKind(key)}>{label}</button>)}</div>
        <div className="creative-material-grid">{filtered.map(item => <button key={item.id} className={chosen.some(m => m.id === item.id) ? 'selected' : ''} onClick={() => selectMaterial(item)}><img src={item.thumb_url} alt="" loading="lazy" /><span>{item.title}</span>{item.kind === 'video' && <Film size={13} />}</button>)}</div>
      </aside>
      <section className="creative-canvas-panel"><div className="creative-canvas-toolbar"><span>{catalogue?.templates.find(t => t.id === design.template)?.category}</span><span>{previewBusy ? '更新预览…' : preview ? `${preview.width} × ${preview.height}` : ''}</span></div>
        <div className="creative-artboard-wrap"><div className={'creative-artboard '+(design.template === 'sticker' ? 'creative-checker' : '')} ref={previewArea} style={{ '--art-ratio': preview ? preview.width/preview.height : 1.44 } as CSSProperties}
          onPointerDown={event => { if (!selectedMaterial || selectedMaterial.kind === 'video' || !design.layers[selected]) return; drag.current = { x: event.clientX, y: event.clientY, original: design.layers[selected] }; event.currentTarget.setPointerCapture(event.pointerId) }}
          onPointerMove={event => { if (!drag.current || !previewArea.current || !preview) return; const rect = previewArea.current.getBoundingClientRect(); const dx = (event.clientX-drag.current.x)/rect.width*preview.width/preview.artwork.width*100, dy = (event.clientY-drag.current.y)/rect.height*preview.height/preview.artwork.height*100; patchLayer({ x: Math.max(0, Math.min(100, drag.current.original.x+dx)), y: Math.max(0, Math.min(100, drag.current.original.y+dy)) }) }}
          onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
          {preview?.video && <video key={preview.video.url} src={preview.video.url} autoPlay muted loop playsInline style={{ left: `${preview.video.x/preview.width*100}%`, top: `${preview.video.y/preview.height*100}%`, width: `${preview.video.width/preview.width*100}%`, height: `${preview.video.height/preview.height*100}%` }} />}
          {preview ? <img draggable={false} src={preview.image} alt="文创成品预览" /> : <div className="creative-empty"><ImagePlus size={25} />选择素材开始创作</div>}
        </div></div>
        <div className="creative-layer-strip">{design.layers.map((layer, index) => { const item = catalogue?.materials.find(m => m.id === layer.material_id); return <button key={index} className={selected === index ? 'active' : ''} onClick={() => setSelected(index)}>{item?.title || '图案'}{design.layers.length > 1 && <span role="button" aria-label={`移除${item?.title}`} onClick={event => { event.stopPropagation(); patch({ layers: design.layers.filter((_, i) => i !== index) }); setSelected(0) }}><X size={13} /></span>}</button> })}</div>
        {work && <Result work={work} onUpdate={setWork} />}
      </section>
      <aside className="creative-controls"><div className="creative-panel-title"><h2>我的设计</h2><Palette size={17} /></div>
        <label>版式<select value={design.template} onChange={event => { const next = catalogue?.templates.find(t => t.id === event.target.value); if (next) { if ((!next.video && chosen.some(m => m.kind === 'video')) || (next.id === 'sticker' && chosen.some(m => !m.has_ink))) chooseTemplate(next); else { patch({ template: next.id }); setKind('all') } } }}>{catalogue?.templates.map(t => <option value={t.id} key={t.id}>{t.category}</option>)}</select></label>
        <label>配色</label><div className="creative-palettes">{Object.entries(catalogue?.palettes || {}).map(([key, p]) => <button key={key} title={p.title} aria-label={p.title} aria-pressed={design.palette === key} className={design.palette === key ? 'active' : ''} style={{ '--swatch': p.bg, '--swatch-ink': p.ink } as CSSProperties} onClick={() => patch({ palette: key as Design['palette'] })}>{design.palette === key ? <Check size={15} /> : <span />}</button>)}</div>
        <label>标题<input maxLength={18} value={design.title} onChange={event => patch({ title: event.target.value })} /></label>
        {design.template !== 'sticker' && <><label>寄语<input maxLength={48} value={design.greeting} onChange={event => patch({ greeting: event.target.value })} /></label><div className="creative-control-row"><label>署名<input maxLength={12} value={design.signature} onChange={event => patch({ signature: event.target.value })} placeholder="你的名字" /></label><label>印章<input maxLength={4} value={design.stamp} onChange={event => patch({ stamp: event.target.value })} /></label></div></>}
        {selectedMaterial?.kind === 'image' && design.layers[selected] && <div className="creative-transform"><label>图案大小<input type="range" min={.15} max={1.5} step={.01} value={design.layers[selected].scale} onChange={event => patchLayer({ scale: +event.target.value })} /></label><div className="creative-control-row"><label>水平<input type="range" min={0} max={100} value={design.layers[selected].x} onChange={event => patchLayer({ x: +event.target.value })} /></label><label>垂直<input type="range" min={0} max={100} value={design.layers[selected].y} onChange={event => patchLayer({ y: +event.target.value })} /></label></div>{selectedMaterial.has_ink && design.template !== 'sticker' && <label className="creative-checkbox"><input type="checkbox" checked={design.layers[selected].tint} onChange={event => patchLayer({ tint: event.target.checked })} />使用单色纹样</label>}</div>}
        <button className="creative-primary creative-export" disabled={busy || work?.status === 'rendering' || previewBusy || !preview} onClick={() => void exportWork()}>{busy || work?.status === 'rendering' ? <LoaderCircle className="creative-spin" size={16} /> : <Download size={16} />}{work?.status === 'rendering' ? '正在导出' : chosen.some(m => m.kind === 'video') ? '导出 5 秒动态卡片' : '导出作品'}</button><Sources items={chosen} />
      </aside>
    </main>}
    {history && <div className="creative-modal-backdrop" onClick={() => setHistory(null)}><section className="creative-history" role="dialog" aria-modal="true" aria-label="我的作品" onClick={event => event.stopPropagation()}><header><h2>我的作品</h2><button aria-label="关闭我的作品" onClick={() => setHistory(null)}><X size={20} /></button></header><div className="creative-history-grid">{history.map(item => <article key={item.id}>{item.status === 'succeeded' && <img src={item.cover_url} alt={item.design.title} />}<h3>{item.design.title}</h3><Result work={item} onUpdate={value => setHistory(previous => previous?.map(w => w.id === value.id ? value : w) || null)} /><button className="creative-button" onClick={() => { setDesign(item.design); setSelected(0); setWork(item); setHistory(null); if (sharedToken) goToSection('creative', { share: null }) }}>继续编辑</button></article>)}</div>{!history.length && <div className="creative-empty">还没有导出的作品</div>}</section></div>}
  </div>
}
