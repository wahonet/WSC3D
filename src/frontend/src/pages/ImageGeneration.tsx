import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, ImagePlus, LoaderCircle } from 'lucide-react'
import AnnotationSourcePicker, { emptySelection, type AnnotationSelection } from '../components/AnnotationSourcePicker'
import { creativeApi, CreativeApiError, type ImageJob, type ImagePrepared, type ImageSettings, type ImageSubmission, type Material } from '../lib/creativeApi'
import { goToSection } from '../lib/navigation'
import './VideoPage.css'

const pendingKey = 'wsc.creative.image.pending'
function restorePending(): ImageSubmission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null')
    return value?.request_id ? value : value?.id ? { request_id: value.id, material_id: value.material || null, style: value.style } : null
  } catch { return null }
}
function remember(value: ImageSubmission | null) { try { value ? sessionStorage.setItem(pendingKey, JSON.stringify(value)) : sessionStorage.removeItem(pendingKey) } catch { /* Keep the request in memory. */ } }

export default function ImageGeneration({ materials, initialMaterialId, onPublish, onMaterialsChanged }: {
  materials: Material[]; initialMaterialId: string; onPublish: (material: Material) => void; onMaterialsChanged: () => Promise<void>
}) {
  const [mode, setMode] = useState<'annotations' | 'materials'>(initialMaterialId ? 'materials' : 'annotations')
  const [selection, setSelection] = useState<AnnotationSelection>(emptySelection), [revision, setRevision] = useState(0)
  const [materialId, setMaterialId] = useState(initialMaterialId), [materialQuery, setMaterialQuery] = useState(''), [materialPage, setMaterialPage] = useState(0)
  const [style, setStyle] = useState('paper'), [settings, setSettings] = useState<ImageSettings | null>(null)
  const [prepared, setPrepared] = useState<{ key: string; data: ImagePrepared } | null>(null), [preparing, setPreparing] = useState(false), [prepareError, setPrepareError] = useState('')
  const [jobs, setJobs] = useState<ImageJob[]>([]), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [pending, setPending] = useState<ImageSubmission | null>(restorePending)
  const pendingRef = useRef(pending), sending = useRef(false), reloadRef = useRef(onMaterialsChanged)
  reloadRef.current = onMaterialsChanged
  const updatePending = (value: ImageSubmission | null) => { pendingRef.current = value; remember(value); setPending(value) }
  const key = JSON.stringify({ ids: [...selection.annotation_ids].sort((a, b) => a - b), style, revision })
  useEffect(() => {
    let current = true, loading = false, previous = ''
    creativeApi.imageSettings().then(value => { if (current) setSettings(value) }).catch(reason => { if (current) setError(reason.message) })
    const load = async () => {
      if (loading) return
      loading = true
      try {
        const values = await creativeApi.imageJobs()
        if (!current) return
        setJobs(values); setLoaded(true)
        const signature = JSON.stringify(values.map(v => [v.id, v.status]))
        if (!previous || previous !== signature) await reloadRef.current()
        previous = signature
        if (pendingRef.current && values.some(v => v.id === pendingRef.current!.request_id)) updatePending(null)
      } catch (reason) { if (current) setError((reason as Error).message) } finally { loading = false }
    }
    void load(); const timer = window.setInterval(load, 5000)
    return () => { current = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    let current = true
    setPrepared(null); setPrepareError('')
    if (mode !== 'annotations' || !selection.annotation_ids.length) { setPreparing(false); return }
    setPreparing(true)
    const timer = window.setTimeout(() => {
      creativeApi.prepareImage(selection.annotation_ids, style).then(data => { if (current) setPrepared({ key, data }) })
        .catch(reason => { if (current) setPrepareError(reason.message) }).finally(() => { if (current) setPreparing(false) })
    }, 250)
    return () => { current = false; window.clearTimeout(timer) }
  }, [key, mode])
  const source = prepared?.key === key ? prepared.data : null
  const material = materials.find(m => m.id === materialId)
  const sourceImage = mode === 'annotations' ? source?.image_url : material?.image_url
  const sourceTitle = mode === 'annotations' ? source?.title : material?.title
  const running = jobs.some(j => j.status === 'running'), locked = busy || !!pending
  const canGenerate = mode === 'annotations' ? !!source && !preparing : !!material || !materialId
  const filtered = materials.filter(m => m.kind === 'image' && [m.title, ...m.tags, m.source.stone_id, m.source.stone_name].join(' ').toLowerCase().includes(materialQuery.toLowerCase()))
  const generate = async () => {
    if (sending.current || !settings?.has_key || !loaded || (!pendingRef.current && (!canGenerate || running))) return
    sending.current = true; setBusy(true); setError('')
    const body = pendingRef.current || { request_id: crypto.randomUUID(), material_id: mode === 'materials' ? materialId || null : null, ...(mode === 'annotations' ? { source_id: source!.id } : {}), style }
    updatePending(body)
    try {
      const job = await creativeApi.generate(body)
      setJobs(previous => [job, ...previous.filter(j => j.id !== job.id)]); updatePending(null)
    } catch (reason) {
      if (reason instanceof CreativeApiError && [400, 403, 409, 422].includes(reason.status)) updatePending(null)
      setError((reason as Error).message)
    } finally { setBusy(false); sending.current = false }
  }
  return <div className="video-page image-generation"><div className="video-inner">
    <header className="video-heading"><h1>图像生成</h1><span>Seedream 5.0 · 2K</span></header>
    <div className="video-workspace"><form className="video-composer" onSubmit={event => { event.preventDefault(); void generate() }}>
      <fieldset disabled={locked}>
        <div className="creative-source-tabs" role="tablist" aria-label="图像来源"><button role="tab" type="button" aria-selected={mode === 'annotations'} onClick={() => setMode('annotations')}>标注图案</button><button role="tab" type="button" aria-selected={mode === 'materials'} onClick={() => setMode('materials')}>已有素材</button></div>
        {mode === 'annotations' ? <AnnotationSourcePicker value={selection} onChange={setSelection} disabled={locked} onRefresh={() => setRevision(v => v + 1)} /> : <div className="image-material-picker">
          <input aria-label="搜索已有素材" placeholder="搜索名称或标签" value={materialQuery} onChange={event => { setMaterialQuery(event.target.value); setMaterialPage(0) }} />
          <div className="image-material-grid"><button type="button" className={!materialId ? 'selected' : ''} onClick={() => setMaterialId('')}><ImagePlus size={23} /><span>流云星象</span></button>{filtered.slice(materialPage * 12, (materialPage + 1) * 12).map(m => <button type="button" key={m.id} className={materialId === m.id ? 'selected' : ''} onClick={() => setMaterialId(m.id)}><img src={m.thumb_url} alt="" loading="lazy" /><span>{m.title}</span></button>)}</div>
          {filtered.length > 12 && <div className="image-material-paging"><button type="button" disabled={!materialPage} onClick={() => setMaterialPage(p => p - 1)}>上一页</button><span>{materialPage + 1} / {Math.ceil(filtered.length / 12)}</span><button type="button" disabled={(materialPage + 1) * 12 >= filtered.length} onClick={() => setMaterialPage(p => p + 1)}>下一页</button></div>}
        </div>}
        <label>画风<select value={style} onChange={event => setStyle(event.target.value)}><option value="paper">汉画套色版画</option><option value="ink">青绿淡彩</option><option value="night">星河汉梦</option></select></label>
      </fieldset>
      {error && <p className="video-error" role="alert">{error}</p>}
      <button className="video-generate" type="submit" disabled={busy || !loaded || !settings?.has_key || (!pending && (running || !canGenerate))}>{busy || (running && !pending) ? <LoaderCircle className="video-spin" size={16} /> : <ImagePlus size={16} />}{pending ? '继续同一请求' : running ? '图像生成中…' : `生成一张 · 约 ¥${settings?.price_per_image.toFixed(2) || '0.22'}`}</button>
      {settings && !settings.has_key && <button type="button" className="video-retry" onClick={() => goToSection('settings')}>配置 Seedream <ArrowRight size={13} /></button>}
    </form><div className="video-results">
      <section className="video-source" aria-label="图像底图与提示词"><div className="video-source-heading"><h2>{sourceTitle || '标注底图'}</h2>{mode === 'annotations' && source && <button type="button" onClick={() => goToSection('research', { stone: source.source.stone_id, a: source.source.asset_id, p: 'annotate', node: source.source.annotation_ids?.[0] })}>查看标注 <ArrowRight size={13} /></button>}</div>
        {sourceImage ? <><div className="video-source-image"><img src={sourceImage} alt={sourceTitle + ' · 生图底图'} /></div>{source && mode === 'annotations' && <><div className="video-source-meta"><span>{source.source.stone_name}</span><span>{source.source.annotation_ids?.length} 处标注</span><span>{source.source.references?.length} 条文献</span></div><details className="video-prompt"><summary>自动提示词</summary><p>{source.prompt}</p></details></>}</> : <div className="video-source-empty">{preparing ? <><LoaderCircle className="video-spin" size={25} /><span role="status">整理标注与文献…</span></> : <><ImagePlus size={28} /><span>{prepareError || (mode === 'materials' ? '流云星象 · 无参考图' : '选择标注后预览底图')}</span></>}</div>}
      </section>
      <section className="video-history" aria-label="图像生成记录"><div className="video-history-heading"><h2>生成记录</h2><span>{jobs.length}</span></div><div className="creative-image-results">{jobs.map(job => { const m = materials.find(m => m.id === job.result_id); return <article key={job.id}>{m ? <><img src={m.image_url} alt={m.title} loading="lazy" /><div><strong>{m.title}</strong><button className="creative-button" onClick={() => onPublish(m)}>查看与发布<ArrowUpRight size={14} /></button></div></> : <div className="creative-empty">{job.status === 'running' ? <><LoaderCircle className="video-spin" size={22} />生成中</> : job.status === 'succeeded' ? '读取生成图片…' : job.error || '任务已中断'}</div>}</article> })}{!jobs.length && <div className="creative-empty">{loaded ? '暂无生成图像' : '读取记录…'}</div>}</div></section>
    </div></div>
  </div></div>
}
