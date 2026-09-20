import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Download, Film, Image, LoaderCircle, Pencil, RotateCw } from 'lucide-react'
import { goToSection } from '../lib/navigation'
import { useApp } from '../store/useApp'
import { videoApi, VideoApiError, type VideoDraft, type VideoJob, type VideoOptions, type VideoPolicy, type VideoPrepared, type VideoSource, type VideoSubmission } from '../lib/videoApi'
import AnnotationSourcePicker from '../components/AnnotationSourcePicker'
import './VideoPage.css'

const draftKey = 'wsc.video.draft.v2', pendingKey = 'wsc.video.pending.v2'
const blank: VideoDraft = { stone_id: '', asset_id: 0, annotation_ids: [], mode: 'fast', duration: 5, style: 'paper' }
const styles = { paper: '汉画剪纸', flat: '平面插画', ink: '水墨淡彩', custom: '按标注描述' }
const active = new Set(['pending', 'submitting', 'queued', 'running', 'downloading'])
const labels: Record<string, string> = { pending: '准备提交', submitting: '提交中', queued: '排队中', running: '生成中', downloading: '保存中', succeeded: '已完成', failed: '生成失败', cancelled: '已取消', submission_uncertain: '待核对', download_failed: '保存失败', query_paused: '查询暂停' }
function restore<T>(key: string, fallback: T): T { try { return JSON.parse(sessionStorage.getItem(key) || 'null') || fallback } catch { return fallback } }
function remember(key: string, value: unknown) { try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Keep the current request identifier in memory. */ } }
function openAnnotation(source: VideoSource) { goToSection('research', { stone: source.stone_id, a: source.asset_id, p: 'annotate', node: source.annotation_ids[0], video_nodes: null }) }

export default function VideoPage() {
  const [draft, setDraft] = useState<VideoDraft>(() => ({ ...blank, ...restore(draftKey, blank) }))
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [sourceRevision, setSourceRevision] = useState(0)
  const [prepared, setPrepared] = useState<{ key: string; value: VideoPrepared } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState('')
  const [editing, setEditing] = useState(false)
  const [editedPrompt, setEditedPrompt] = useState('')
  const [pending, setPending] = useState<VideoSubmission | null>(() => restore(pendingKey, null))
  const pendingRef = useRef(pending)
  const [policy, setPolicy] = useState<VideoPolicy | null>(null)
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState('')
  const updatePending = (value: VideoSubmission | null) => {
    pendingRef.current = value; remember(pendingKey, value); setPending(value)
  }
  useEffect(() => { remember(draftKey, draft) }, [draft])
  useEffect(() => {
    let current = true, loading = false
    const load = async () => {
      if (loading) return
      loading = true
      try {
        const values = await videoApi.jobs()
        if (!current) return
        setJobs(values); setLoaded(true)
        if (pendingRef.current && values.some(job => job.id === pendingRef.current!.request_id)) updatePending(null)
      } catch (reason) { if (current) setError((reason as Error).message) }
      finally { loading = false }
    }
    videoApi.settings().then(value => { if (current) setPolicy(value) }).catch(reason => { if (current) setError(reason.message) })
    const loadSelection = async () => {
      const q = new URLSearchParams(location.hash.slice(1))
      const requested = (q.get('video_nodes') || '').split(',').map(Number).filter(id => id > 0)
      if (q.has('video_nodes')) { q.delete('video_nodes'); history.replaceState(null, '', '#' + q.toString()) }
      const selected = useApp.getState().selectedId
      const ids = (requested.length ? requested : draft.annotation_ids.length ? draft.annotation_ids : selected ? [selected] : []).slice(0, 20)
      const values = ids.length ? (await videoApi.annotations({ ids, limit: 20 })).items : []
      if (!current) return
      const first = values[0]
      setDraft(previous => ({ ...previous, stone_id: first?.stone_id || '', asset_id: first?.asset_id || 0,
        annotation_ids: values.filter(node => node.asset_id === first?.asset_id).map(node => node.id) }))
      setSourcesLoaded(true)
    }
    void loadSelection().catch(reason => { if (current) { setError(reason.message); setSourcesLoaded(true) } })
    void load()
    const timer = window.setInterval(load, 15000)
    return () => { current = false; window.clearInterval(timer) }
  }, [])

  const optionsKey = JSON.stringify({ annotation_ids: [...draft.annotation_ids].sort((a, b) => a - b), mode: draft.mode, duration: draft.duration, style: draft.style } satisfies VideoOptions)
  useEffect(() => {
    let current = true
    setPrepared(null); setEditing(false); setEditedPrompt(''); setPrepareError('')
    const options = JSON.parse(optionsKey) as VideoOptions
    if (!sourcesLoaded || !options.annotation_ids.length) { setPreparing(false); return }
    setPreparing(true)
    const timer = window.setTimeout(() => {
      videoApi.prepare(options).then(value => { if (current) setPrepared({ key: optionsKey, value }) })
        .catch(reason => { if (current) setPrepareError(reason.message) }).finally(() => { if (current) setPreparing(false) })
    }, 200)
    return () => { current = false; window.clearTimeout(timer) }
  }, [optionsKey, sourcesLoaded, sourceRevision])

  const source = prepared?.key === optionsKey ? prepared.value : null
  const prompt = editing ? editedPrompt : source?.prompt || ''
  const preset = policy?.modes.find(item => item.id === draft.mode)
  const running = jobs.some(job => active.has(job.status))
  const locked = busy || !!pending
  const cost = preset ? (draft.duration * preset.price_per_second).toFixed(2) : '—'
  const patch = (value: Partial<VideoDraft>) => { setDraft(previous => ({ ...previous, ...value })); setError('') }
  const submit = async () => {
    if (sending.current || !policy?.configured || !loaded || (!pending && (!source || !prompt.trim() || preparing || running))) return
    sending.current = true; setBusy(true); setError('')
    const body = pendingRef.current || { source_id: source!.id, ...(editing ? { prompt: prompt.trim() } : {}), request_id: crypto.randomUUID() }
    updatePending(body)
    try {
      const job = await videoApi.create(body)
      setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)])
      updatePending(null)
    } catch (reason) {
      if (reason instanceof VideoApiError && [400, 403, 409, 422].includes(reason.status)) {
        updatePending(null); setError(reason.message)
      } else setError('连接中断，可继续提交同一任务。')
    } finally { sending.current = false; setBusy(false) }
  }
  const refresh = async (job: VideoJob) => {
    setRefreshing(job.id); setError('')
    try {
      const value = await videoApi.refresh(job.id)
      setJobs(previous => previous.map(item => item.id === value.id ? value : item))
    } catch (reason) { setError((reason as Error).message) }
    finally { setRefreshing('') }
  }

  return <div className="video-page"><div className="video-inner">
    <header className="video-heading"><h1>视频生成</h1></header>
    <div className="video-workspace">
      <form className="video-composer" onSubmit={event => { event.preventDefault(); void submit() }}>
        <fieldset disabled={locked}>
          {sourcesLoaded && <AnnotationSourcePicker value={draft} onChange={patch} disabled={locked} onRefresh={() => setSourceRevision(v => v + 1)} />}
          <div className="video-modes" role="radiogroup" aria-label="生成模式">
            {policy?.modes.map(mode => <label key={mode.id} className={mode.id === draft.mode ? 'selected' : ''}>
              <input type="radio" name="video-mode" value={mode.id} checked={mode.id === draft.mode} onChange={() => patch({ mode: mode.id, duration: mode.durations.includes(draft.duration) ? draft.duration : 5 })} />
              <strong>{mode.label}</strong><span>{mode.model.replace('MiniMax-', '')} · {mode.resolution.toLowerCase()}</span>
            </label>)}
          </div>
          <div className="video-options"><label>画风<select value={draft.style} onChange={event => patch({ style: event.target.value as VideoDraft['style'] })}>{Object.entries(styles).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
            <label>时长<select value={draft.duration} onChange={event => patch({ duration: Number(event.target.value) as 4 | 5 })}>{(preset?.durations || [5]).map(duration => <option key={duration} value={duration}>{duration} 秒</option>)}</select></label></div>
        </fieldset>
        {policy && !policy.configured && <div className="video-config-missing">{policy.error}<button type="button" onClick={() => goToSection('settings')}>API配置 <ArrowRight size={14} /></button></div>}
        {error && <p className="video-error" role="alert">{error}</p>}
        <button className="video-generate" type="submit" disabled={busy || !loaded || !policy?.configured || (!pending && (running || !source || preparing || !prompt.trim()))}>
          {busy || (running && !pending) ? <LoaderCircle size={17} className="video-spin" /> : <Film size={17} />}
          {busy ? '提交中…' : pending ? '继续提交同一任务' : running ? '视频生成中…' : '生成视频 · 约 ¥' + cost}
        </button>
        <div className="video-cost-note">每次 1 条 · 以 MiniMax 实际结算为准</div>
      </form>
      <div className="video-results">
        <section className="video-source" aria-label="标注底图与提示词">
          <div className="video-source-heading"><h2>{source?.title || '标注底图'}</h2>{source && <button type="button" onClick={() => openAnnotation(source.source)}>查看标注 <ArrowRight size={13} /></button>}</div>
          {source ? <>
            <div className="video-source-image"><img src={source.image_url} alt={source.title + ' · 标注底图'} /></div>
            <div className="video-source-meta"><span>{source.source.stone_name}</span><span>{source.source.annotation_ids.length} 处标注</span><span>{source.source.references.filter(ref => !ref.source_missing).length} 条文献</span></div>
            <details className="video-prompt"><summary>自动提示词</summary>
              <div className="video-prompt-tools"><button type="button" disabled={locked} onClick={() => { setEditing(!editing); setEditedPrompt(source.prompt) }}>{editing ? <RotateCw size={12} /> : <Pencil size={12} />}{editing ? '恢复自动提示词' : '编辑提示词'}</button></div>
              {editing ? <textarea aria-label="提示词" value={editedPrompt} maxLength={7000} disabled={locked} onChange={event => setEditedPrompt(event.target.value)} /> : <p>{source.prompt}</p>}
            </details>
          </> : <div className="video-source-empty">{preparing ? <><LoaderCircle size={25} className="video-spin" /><span role="status">整理标注与文献…</span></> : <><Image size={28} /><span>{prepareError || '选择标注后预览底图'}</span></>}</div>}
        </section>
        <section className="video-history" aria-label="生成记录"><div className="video-history-heading"><h2>生成记录</h2><span>{jobs.length}</span></div>
          {!jobs.length && <div className="video-empty"><Film size={28} /><span>{loaded ? '暂无视频' : '读取记录…'}</span></div>}
          {jobs.map(job => <article key={job.id} className="video-job">
            {job.video_url ? <video src={job.video_url} poster={job.poster_url || undefined} controls playsInline preload="none" aria-label={job.title} /> : <div className="video-job-waiting">{active.has(job.status) ? <LoaderCircle size={24} className="video-spin" /> : <Film size={24} />}<span role="status">{labels[job.status] || job.status}</span></div>}
            <div className="video-job-body"><div className="video-job-title"><h3>{job.title}</h3>{job.video_url && <a href={job.video_url} download={job.title + '.mp4'} aria-label={'下载' + job.title}><Download size={16} />下载</a>}</div>
              <div className="video-job-meta"><span>{job.model.replace('MiniMax-', '')} · {job.resolution.toLowerCase()}</span><span>{styles[job.style]}</span><span>{(job.actual_duration || job.duration).toFixed(1)} 秒</span><time dateTime={job.created_at}>{new Date(job.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>
              {job.source && <button type="button" className="video-retry" onClick={() => openAnnotation(job.source!)}>来源标注 <ArrowRight size={12} /></button>}
              {job.error && <p className="video-error">{job.error}</p>}
              {['download_failed', 'query_paused'].includes(job.status) && <button className="video-retry" disabled={refreshing === job.id} onClick={() => void refresh(job)}><RotateCw size={14} />继续查询</button>}
              <details><summary>生成提示词</summary><p>{job.prompt}</p></details>
            </div>
          </article>)}
        </section>
      </div>
    </div>
  </div></div>
}
