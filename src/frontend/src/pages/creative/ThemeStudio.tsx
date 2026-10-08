import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Check, Film, LoaderCircle, Plus, RotateCw, Sparkles, Trash2, X } from 'lucide-react'
import { studioApi, CHECKLIST, PALETTE_NAMES, STYLES, type AdminTheme, type ImageJob, type ImageSettings, type Material, type Palette, type Step, type Sticker, type StoryRef, type ThemeChanges, type Venue } from '../../lib/creativeApi'
import { videoApi, type VideoJob } from '../../lib/videoApi'
import AnnotationSourcePicker, { type AnnotationSelection } from '../../components/AnnotationSourcePicker'
import { goToSection } from '../../lib/navigation'
import { useEscape } from '../../hooks/useEscape'

const REVIEWER_KEY = 'wsc.creative.reviewer'
const STATUS: Record<string, string> = { reviewed: '已审', approved: '已审定', candidate: '候选', draft: '草稿', rejected: '已驳回' }
const length = (text: string) => text.replace(/\s/g, '').length
const inkUrl = (m: Material) => `/api/creative/admin/materials/${m.id}/ink`

type Ctx = {
  theme: AdminTheme; materials: Material[]; venue: Venue | null; busy: string; reviewer: string; setReviewer: (value: string) => void
  run: (label: string, fn: () => Promise<unknown>, done?: string) => Promise<boolean>; save: (changes: ThemeChanges, done?: string) => Promise<boolean>
  apply: (theme: AdminTheme) => void; reload: () => Promise<void>; job: ImageJob | null; startJob: (role: 'line' | 'color', count: number, style?: string) => Promise<void>
  settings: ImageSettings | null
}

export default function ThemeStudio({ id, venue, onBack }: { id: string; venue: Venue | null; onBack: () => void }) {
  const [theme, setTheme] = useState<AdminTheme | null>(null), [materials, setMaterials] = useState<Material[]>([])
  const [step, setStep] = useState<Step['key']>('project'), [busy, setBusy] = useState('')
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [reviewer, setReviewerState] = useState(() => { try { return localStorage.getItem(REVIEWER_KEY) || '' } catch { return '' } })
  const [job, setJob] = useState<ImageJob | null>(null), [settings, setSettings] = useState<ImageSettings | null>(null)
  const reload = async () => { const [t, m] = await Promise.all([studioApi.theme(id), studioApi.materials(id)]); setTheme(t); setMaterials(m) }
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    reload().then(() => undefined).catch(reason => setError(reason.message))
    studioApi.imageSettings().then(setSettings).catch(() => undefined)
    studioApi.imageJobs().then(list => setJob(list.find(j => j.theme === id && j.status === 'running') || null)).catch(() => undefined)
  }, [id])
  useEffect(() => {
    if (job?.status !== 'running') return
    const timer = window.setInterval(() => {
      studioApi.imageJobs().then(list => {
        const next = list.find(j => j.id === job.id)
        if (!next) return
        if (next.done !== job.done || next.status !== 'running') void reloadRef.current()
        setJob(next)
      }).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [job?.id, job?.status, job?.done])

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label); setError(''); setNotice('')
    try { await fn(); if (done) setNotice(done); return true }
    catch (reason) { setError((reason as Error).message); return false }
    finally { setBusy('') }
  }
  const ctx: Ctx | null = theme && {
    theme, materials, venue, busy, reviewer, settings, job, reload,
    setReviewer: value => { setReviewerState(value); try { localStorage.setItem(REVIEWER_KEY, value) } catch { /* optional */ } },
    run, apply: setTheme,
    save: (changes, done = '已保存') => run('save', async () => setTheme(await studioApi.update(id, changes)), done),
    startJob: async (role, count, style) => { await run('job', async () => setJob(await studioApi.candidates(id, { request_id: crypto.randomUUID(), role, style: style || null, count }))) },
  }
  if (!theme || !ctx) return <div className="cs-body"><div className="cs-empty">{error || <><LoaderCircle className="cs-spin" size={22} />载入主题</>}</div></div>
  const current = theme.steps.find(s => s.key === step) || theme.steps[0]
  const panels: Record<Step['key'], ReactNode> = {
    project: <ProjectStep ctx={ctx} onDeleted={onBack} />, original: <OriginalStep ctx={ctx} />, line: <LineStep ctx={ctx} />, color: <ColorStep ctx={ctx} />,
    video: <VideoStep ctx={ctx} />, story: <StoryStep ctx={ctx} />, products: <ProductsStep ctx={ctx} />, publish: <PublishStep ctx={ctx} />,
  }
  return <div className="cs-body cs-theme">
    <header className="cs-theme-head">
      <button className="cs-back" onClick={onBack}><ArrowLeft size={16} />全部主题</button>
      <div><h1>{theme.title}</h1><span>{theme.stone_id} · {theme.stone_name}</span></div>
      <span className={'cs-status ' + theme.status}>{theme.status === 'published' ? '已上架' : '制作中'}</span>
      <span className="cs-fill" />
      {job?.status === 'running' && <span className="cs-job"><LoaderCircle className="cs-spin" size={14} />{job.role === 'line' ? '线描' : '演绎'}生成中 {job.done || 0}/{job.count}</span>}
      {theme.status === 'published' && <button className="cs-button" onClick={() => goToSection('creative', { theme: theme.id, ct: null, creative_tab: null })}>观众页<ArrowUpRight size={14} /></button>}
    </header>
    <div className="cs-theme-grid">
      <ol className="cs-steps">{theme.steps.map((s, i) => <li key={s.key}><button className={(s.key === current.key ? 'active ' : '') + (s.done ? 'done' : '')} onClick={() => { setStep(s.key); setError(''); setNotice('') }}>
        <b>{s.done ? <Check size={14} /> : i + 1}</b><span><strong>{s.title}{s.optional && <small>可选</small>}</strong><small>{s.detail}</small></span></button></li>)}</ol>
      <section className="cs-panel" aria-label={current.title}>
        <div className="cs-panel-head"><h2>{current.title}</h2><span>{current.detail}</span></div>
        {error && <p className="cs-error" role="alert">{error}<button aria-label="关闭" onClick={() => setError('')}><X size={14} /></button></p>}
        {notice && <p className="cs-notice" role="status"><Check size={15} />{notice}</p>}
        {panels[current.key]}
      </section>
    </div>
  </div>
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <label className="cs-field"><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>
}

function Reviewer({ ctx }: { ctx: Ctx }) {
  return <Field label="核对人" hint="记录在审核记录里"><input maxLength={40} value={ctx.reviewer} placeholder="填写姓名" onChange={event => ctx.setReviewer(event.target.value)} /></Field>
}

// ------------------------------------------------------------------ 1 立项

function ProjectStep({ ctx, onDeleted }: { ctx: Ctx; onDeleted: () => void }) {
  const { theme, venue } = ctx
  const [form, setForm] = useState({ title: theme.title, subject: theme.subject, hall: theme.hall?.id || '', order: theme.order })
  const [picking, setPicking] = useState(false)
  const [selection, setSelection] = useState<AnnotationSelection>({ stone_id: theme.stone_id, asset_id: 0, annotation_ids: theme.annotation_ids })
  const asset = ctx.materials.find(m => m.id === theme.assets.original)?.source.asset_id
  return <div className="cs-form">
    <Field label="主题名" hint="2–18 字，观众看到的标题"><input maxLength={18} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></Field>
    <Field label="画面描述" hint="给线描与演绎模型的说明：人物、动作、器物，只写原石上有的">
      <textarea rows={4} maxLength={600} value={form.subject} onChange={event => setForm({ ...form, subject: event.target.value })} /></Field>
    <div className="cs-row">
      <Field label="所属展厅"><select value={form.hall} onChange={event => setForm({ ...form, hall: event.target.value })}><option value="">未指定</option>{venue?.halls.map(h => <option key={h.id} value={h.id}>{h.name} · {h.chapter}</option>)}</select></Field>
      <Field label="排序" hint="越小越靠前"><input type="number" min={0} max={999} value={form.order} onChange={event => setForm({ ...form, order: Number(event.target.value) || 0 })} /></Field>
    </div>
    <div className="cs-actions"><button className="cs-primary" disabled={!!ctx.busy} onClick={() => void ctx.save({ title: form.title.trim(), subject: form.subject.trim(), hall: form.hall || null, order: form.order })}>保存</button></div>
    <h3>依据标注</h3>
    <p className="cs-hint">主题只能建立在已审核的结构标注上。标注未审核时，请先到「图像研究 → 结构标注」审核。</p>
    <ul className="cs-list">{theme.annotations.map(n => <li key={n.id}><span className={'cs-dot ' + (['reviewed', 'approved'].includes(n.status) ? 'ok' : 'warn')} />
      <strong>{n.label}</strong><small>#{n.id} · {STATUS[n.status] || n.status}</small>
      <button className="cs-link" onClick={() => goToSection('research', { stone: theme.stone_id, a: asset || null, p: 'annotate', node: n.id, creative_tab: null, ct: null })}>打开标注<ArrowUpRight size={13} /></button></li>)}</ul>
    {picking ? <div className="cs-picker"><AnnotationSourcePicker value={selection} onChange={setSelection} disabled={!!ctx.busy} />
      <div className="cs-actions"><button className="cs-button" onClick={() => setPicking(false)}>取消</button>
        <button className="cs-primary" disabled={!!ctx.busy || !selection.annotation_ids.length} onClick={() => void ctx.save({ annotation_ids: selection.annotation_ids }, '标注已更换，请到「原图」重新导出').then(ok => ok && setPicking(false))}>使用这些标注</button></div></div>
      : <button className="cs-button" onClick={() => setPicking(true)}>更换标注</button>}
    <div className="cs-danger"><button className="cs-link danger" disabled={!!ctx.busy} onClick={() => {
      if (window.confirm(`删除主题「${theme.title}」？候选图会一并删除，素材库中采用的素材保留。`)) void ctx.run('delete', () => studioApi.remove(theme.id)).then(ok => ok && onDeleted())
    }}><Trash2 size={14} />删除主题</button></div>
  </div>
}

// ------------------------------------------------------------------ 2 原图

function OriginalStep({ ctx }: { ctx: Ctx }) {
  const original = ctx.materials.find(m => m.id === ctx.theme.assets.original)
  return <div className="cs-form">
    <p className="cs-hint">按标注范围从原石拓片上裁出局部，这是线描、演绎和观众端「依据」的唯一来源。更换标注后需要重新导出。</p>
    {original ? <figure className="cs-paper cs-original"><img src={original.image_url + '?t=' + original.created_at} alt="原图" /><figcaption>{original.width} × {original.height} · {original.source.stone_id} · {original.source.annotation_ids?.length || 0} 条标注 · {original.source.references?.length || 0} 条文献</figcaption></figure>
      : <div className="cs-empty">尚未导出原图</div>}
    <div className="cs-actions"><button className="cs-primary" disabled={!!ctx.busy} onClick={() => void ctx.run('original', async () => { ctx.apply(await studioApi.original(ctx.theme.id)); await ctx.reload() }, '原图已导出')}>
      {ctx.busy === 'original' ? <LoaderCircle className="cs-spin" size={15} /> : <RotateCw size={15} />}{original ? '重新导出' : '导出原图'}</button></div>
  </div>
}

// ------------------------------------------------------------------ 3 线描

function Generate({ ctx, role, style }: { ctx: Ctx; role: 'line' | 'color'; style?: string }) {
  const [count, setCount] = useState(2)
  const running = ctx.job?.status === 'running'
  const price = ctx.settings?.price_per_image || 0.22
  return <div className="cs-generate">
    <Field label="张数"><select value={count} onChange={event => setCount(Number(event.target.value))}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 张</option>)}</select></Field>
    <button className="cs-primary" disabled={!!ctx.busy || running || !ctx.settings?.has_key} onClick={() => void ctx.startJob(role, count, style)}>
      {running || ctx.busy === 'job' ? <LoaderCircle className="cs-spin" size={15} /> : <Sparkles size={15} />}生成{role === 'line' ? '线描' : '演绎'}候选</button>
    <span className="cs-hint">Seedream 5.0 · 约 ¥{(price * count).toFixed(2)}{!ctx.settings?.has_key && ' · 请先在「API配置」填写 Seedream 密钥'}</span>
    {ctx.job && ctx.job.role === role && ctx.job.status !== 'running' && ctx.job.status !== 'succeeded' && <span className="cs-error-inline">上次生成：{ctx.job.error || ctx.job.status}</span>}
  </div>
}

function LineCompare({ original, candidate, selected }: { original: Material; candidate: Material; selected: boolean }) {
  const [mode, setMode] = useState<'side' | 'overlay'>('side'), [opacity, setOpacity] = useState(.75), [flip, setFlip] = useState(false)
  // AI drafts sometimes come out mirrored; flipping the candidate makes a reversed figure obvious.
  const mirror = flip ? { transform: 'scaleX(-1)' } : undefined
  return <div className="cs-compare">
    <div className="cs-seg">{([['side', '并排'], ['overlay', '叠加']] as const).map(([key, label]) => <button key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}
      <button className="cs-seg-gap" aria-pressed={flip} onClick={() => setFlip(!flip)}>左右翻转候选</button>
      {mode === 'overlay' && <label>线描浓度<input type="range" min={0} max={1} step={.05} value={opacity} onChange={event => setOpacity(Number(event.target.value))} /></label>}</div>
    {mode === 'side' ? <div className="cs-side"><figure className="cs-paper"><img src={original.image_url} alt="原图" /><figcaption>原图</figcaption></figure>
      <figure className="cs-paper"><img src={candidate.image_url} alt="线描候选" style={mirror} /><figcaption>{selected ? '已选定' : '候选'}{flip && '（已翻转）'} · 墨色覆盖 {candidate.coverage != null ? Math.round(candidate.coverage * 100) + '%' : '—'}</figcaption></figure></div>
      : <figure className="cs-paper cs-overlay"><div><img src={original.image_url} alt="原图" /><i style={{ opacity, WebkitMaskImage: `url(${inkUrl(candidate)})`, maskImage: `url(${inkUrl(candidate)})`, ...mirror }} /></div>
        <figcaption>红线为候选线描，按画幅拉伸近似对齐；细节以并排核对为准</figcaption></figure>}
  </div>
}

function LineStep({ ctx }: { ctx: Ctx }) {
  const { theme, materials } = ctx
  const original = materials.find(m => m.id === theme.assets.original)
  const candidates = materials.filter(m => m.candidate_for === 'line')
  const [pick, setPick] = useState(() => candidates.find(m => m.id === theme.assets.line)?.id || candidates[0]?.id || '')
  const [checks, setChecks] = useState<Record<string, boolean>>({}), [note, setNote] = useState(''), [library, setLibrary] = useState(false)
  const chosen = candidates.find(m => m.id === pick) || candidates[0]
  useEffect(() => { if (!candidates.some(m => m.id === pick) && candidates[0]) setPick(candidates[0].id) }, [candidates.length])
  const approved = chosen && theme.assets.line === chosen.id && theme.line_kind === 'line'
  if (!original) return <div className="cs-empty">请先在「原图」导出标注局部</div>
  return <div className="cs-form">
    <p className="cs-hint">AI 只负责起稿：以原图为参考生成白描候选，自动去底成透明线稿。每张候选都要对照原图逐项核对，全部通过才能选定；实在没有合格候选，可以暂用拓片底稿上线。</p>
    <Generate ctx={ctx} role="line" />
    {candidates.length ? <>
      <div className="cs-thumbs">{candidates.map(m => <button key={m.id} aria-pressed={m.id === chosen?.id} onClick={() => { setPick(m.id); setChecks({}) }}>
        <img src={m.thumb_url} alt="" /><small>{m.id === theme.assets.line ? '已选定' : m.origin === 'seedream' ? '候选' : '素材库'}{m.coverage != null && ` · ${Math.round(m.coverage * 100)}%`}</small></button>)}
        <button className="cs-thumb-add" onClick={() => setLibrary(true)}><Plus size={18} />从素材库选</button></div>
      {chosen && <LineCompare original={original} candidate={chosen} selected={chosen.id === theme.assets.line} />}
      {chosen && (approved ? <p className="cs-notice"><Check size={15} />这张线描已由 {theme.approvals.line?.reviewer} 于 {theme.approvals.line?.at?.slice(0, 10)} 核对通过</p> : <div className="cs-review">
        <h3>逐项核对</h3>
        {CHECKLIST.map(([key, label]) => <label key={key} className="cs-check"><input type="checkbox" checked={!!checks[key]} onChange={event => setChecks({ ...checks, [key]: event.target.checked })} />{label}</label>)}
        <div className="cs-row"><Reviewer ctx={ctx} /><Field label="备注"><input maxLength={300} value={note} onChange={event => setNote(event.target.value)} placeholder="可不填" /></Field></div>
        <div className="cs-actions"><button className="cs-primary" disabled={!!ctx.busy || CHECKLIST.some(([key]) => !checks[key]) || !ctx.reviewer.trim()} onClick={() => void ctx.run('approve', async () => {
          ctx.apply(await studioApi.approve(theme.id, { role: 'line', material_id: chosen.id, checklist: checks, reviewer: ctx.reviewer, note })); await ctx.reload()
        }, '线描已选定，成品需要重新渲染')}><Check size={15} />核对通过，选定这张</button></div>
      </div>)}
    </> : <div className="cs-empty">还没有线描候选<button className="cs-button" onClick={() => setLibrary(true)}><Plus size={15} />从素材库选</button></div>}
    <div className="cs-fallback">
      <div><strong>暂用拓片底稿</strong><span>{theme.line_kind === 'rubbing' ? '当前正在使用拓片底稿，观众端标注为「拓片底稿」。' : '没有合格线描时，用原图的去底拓片先上线，之后再替换。'}</span></div>
      <button className="cs-button" disabled={!!ctx.busy || !ctx.reviewer.trim() || theme.line_kind === 'rubbing' && theme.assets.line === theme.assets.original}
        onClick={() => void ctx.run('approve', async () => { ctx.apply(await studioApi.approve(theme.id, { role: 'rubbing', reviewer: ctx.reviewer, note })); await ctx.reload() }, '已改用拓片底稿')}>使用拓片底稿</button>
    </div>
    {library && <LibraryPicker ctx={ctx} role="line" onClose={() => setLibrary(false)} onPicked={m => setPick(m.id)} />}
  </div>
}

function LibraryPicker({ ctx, role, onClose, onPicked }: { ctx: Ctx; role: 'line' | 'color' | 'video'; onClose: () => void; onPicked: (m: Material) => void }) {
  const [items, setItems] = useState<Material[] | null>(null), [error, setError] = useState('')
  useEscape(onClose, true)
  useEffect(() => { studioApi.library().then(setItems).catch(reason => setError(reason.message)) }, [])
  const fits = (m: Material) => (!m.theme || m.theme === ctx.theme.id) && m.role !== 'original' && (role === 'video' ? m.kind === 'video' : m.kind === 'image' && (role === 'color' || m.has_ink))
  const list = (items || []).filter(fits)
  return <div className="cs-backdrop" onClick={onClose}><section className="cs-dialog" role="dialog" aria-modal="true" aria-label="从素材库选" onClick={event => event.stopPropagation()}>
    <header><h2>从素材库选{role === 'line' ? '线描' : role === 'color' ? '演绎图' : '短片'}</h2><button className="cs-icon" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
    {role === 'line' && <p className="cs-hint">只列出带透明线稿的素材。</p>}
    {items ? list.length ? <div className="cs-thumbs is-dialog">{list.map(m => <button key={m.id} disabled={!!ctx.busy} onClick={() => void ctx.run('adopt', async () => { const item = await studioApi.adopt(ctx.theme.id, m.id, role); await ctx.reload(); onPicked(item); onClose() }, '已加入候选')}>
      <img src={m.thumb_url} alt="" /><small>{m.title}</small></button>)}</div> : <div className="cs-empty">没有合适的素材</div> : <div className="cs-empty">{error || <LoaderCircle className="cs-spin" size={20} />}</div>}
  </section></div>
}

// ------------------------------------------------------------------ 4 演绎

function ColorStep({ ctx }: { ctx: Ctx }) {
  const { theme, materials } = ctx
  const [style, setStyle] = useState('paper'), [library, setLibrary] = useState(false)
  const candidates = materials.filter(m => m.candidate_for === 'color')
  const selected = theme.assets.colors
  if (!theme.assets.line) return <div className="cs-empty">请先在「线描」选定线描或拓片底稿</div>
  const toggle = (m: Material, on: boolean) => ctx.run('approve', async () => {
    ctx.apply(await studioApi.approve(theme.id, { role: 'color', material_id: m.id, selected: on, reviewer: ctx.reviewer })); await ctx.reload()
  }, on ? '已选定' : '已取消选定')
  return <div className="cs-form">
    <p className="cs-hint">以选定的线描为底稿上色。演绎图在观众端始终标注「艺术演绎」。每个主题最多选定两张，第一张作封面。</p>
    <div className="cs-row"><Field label="画风"><select value={style} onChange={event => setStyle(event.target.value)}>{STYLES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Reviewer ctx={ctx} /></div>
    <Generate ctx={ctx} role="color" style={style} />
    <div className="cs-colors">{candidates.map(m => { const on = selected.includes(m.id); return <article key={m.id} className={on ? 'on' : ''}>
      <img src={m.thumb_url} alt="" />
      <div><small>{STYLES.find(([key]) => key === m.style)?.[1] || (m.origin === 'seedream' ? '演绎' : '素材库')}{on && ` · 第 ${selected.indexOf(m.id) + 1} 张`}</small>
        <button className={on ? 'cs-button' : 'cs-primary'} disabled={!!ctx.busy || !ctx.reviewer.trim() || (!on && selected.length >= 2)} onClick={() => void toggle(m, !on)}>{on ? '取消选定' : '选定'}</button></div>
    </article> })}
      <button className="cs-thumb-add" onClick={() => setLibrary(true)}><Plus size={18} />从素材库选</button></div>
    {!ctx.reviewer.trim() && <p className="cs-hint">填写核对人后才能选定。</p>}
    {library && <LibraryPicker ctx={ctx} role="color" onClose={() => setLibrary(false)} onPicked={() => undefined} />}
  </div>
}

// ------------------------------------------------------------------ 5 动态

function VideoStep({ ctx }: { ctx: Ctx }) {
  const { theme, materials } = ctx
  const [jobs, setJobs] = useState<VideoJob[] | null>(null), [error, setError] = useState('')
  const clips = materials.filter(m => m.kind === 'video')
  useEffect(() => { videoApi.jobs().then(list => setJobs(list.filter(j => j.status === 'succeeded'))).catch(reason => setError(reason.message)) }, [])
  const use = (id: string | null) => ctx.run('video', async () => { ctx.apply(await studioApi.approve(theme.id, { role: 'video', material_id: id })); await ctx.reload() }, id ? '已关联短片，成品会生成动态明信片' : '已取消关联')
  return <div className="cs-form">
    <p className="cs-hint">可选。短片在「动态短片」页生成（每条约 ¥1–2），这里把合格的一条关联到主题，观众端会多出五秒动态明信片。</p>
    {clips.length > 0 && <div className="cs-colors">{clips.map(m => { const on = theme.assets.video === m.id; return <article key={m.id} className={on ? 'on' : ''}>
      <video src={m.video_url || ''} poster={m.image_url} muted loop playsInline controls />
      <div><small>{m.title}</small><button className={on ? 'cs-button' : 'cs-primary'} disabled={!!ctx.busy} onClick={() => void use(on ? null : m.id)}>{on ? '取消关联' : '关联'}</button></div>
    </article> })}</div>}
    <h3>从已完成的视频任务导入</h3>
    {jobs ? jobs.length ? <div className="cs-list-media">{jobs.map(j => <button key={j.id} disabled={!!ctx.busy} onClick={() => void ctx.run('import', async () => {
      const item = await studioApi.importVideo(j.id); await studioApi.adopt(theme.id, item.id, 'video'); await ctx.reload()
    }, '已导入，请点「关联」')}>{j.poster_url ? <img src={j.poster_url} alt="" /> : <Film size={20} />}<span>{j.title}</span><Plus size={16} /></button>)}</div>
      : <div className="cs-empty">没有已完成的视频任务<button className="cs-button" onClick={() => goToSection('video', { creative_tab: 'video', ct: null })}>去生成短片</button></div>
      : <div className="cs-empty">{error || <LoaderCircle className="cs-spin" size={20} />}</div>}
  </div>
}

// ------------------------------------------------------------------ 6 文案

function StoryStep({ ctx }: { ctx: Ctx }) {
  const { theme, materials } = ctx
  const [hook, setHook] = useState(theme.hook), [story, setStory] = useState(theme.story)
  const [refs, setRefs] = useState<StoryRef[]>(theme.story_refs), [greetings, setGreetings] = useState<string[]>(theme.greetings)
  const [draftNote, setDraftNote] = useState('')
  const original = materials.find(m => m.id === theme.assets.original)
  const same = (a: StoryRef, b: StoryRef) => a.document_id === b.document_id && a.page_no === b.page_no
  const available = (original?.source.references || []).filter(r => !refs.some(x => same(x, r)))
  const count = length(story), fits = count >= 100 && count <= 160
  return <div className="cs-form">
    <Field label="引子" hint={`${hook.length}/14 字，卡片上的一句话`}><input maxLength={14} value={hook} onChange={event => setHook(event.target.value)} /></Field>
    <Field label="故事" hint={<span className={fits ? 'ok' : 'warn'}>{count} 字 · 要求 100–160 字</span>}><textarea rows={6} maxLength={400} value={story} onChange={event => setStory(event.target.value)} /></Field>
    <div className="cs-actions left"><button className="cs-button" disabled={!!ctx.busy} onClick={() => void ctx.run('draft', async () => {
      const draft = await studioApi.storyDraft(theme.id); setHook(draft.hook || hook); setStory(draft.story); setDraftNote(`AI 草稿（${draft.model || '文案模型'}，${draft.length} 字）已填入，请对照出处修改后保存。${draft.notice || ''}`)
    })}>{ctx.busy === 'draft' ? <LoaderCircle className="cs-spin" size={15} /> : <Sparkles size={15} />}AI 起草</button>{draftNote && <span className="cs-hint">{draftNote}</span>}</div>
    <h3>故事出处 <small>至少一条，观众端可点开原书</small></h3>
    <ul className="cs-refs">{refs.map((r, i) => <li key={i}><div><strong>《{r.document_title}》第 {r.page_no} 页</strong><p>{r.text}</p></div><button className="cs-icon" aria-label="移除出处" onClick={() => setRefs(refs.filter((_, n) => n !== i))}><X size={15} /></button></li>)}</ul>
    {available.length > 0 && <><p className="cs-hint">标注已关联的文献，点击加入：</p><ul className="cs-refs is-available">{available.map((r, i) => <li key={i}><div><strong>《{r.document_title}》第 {r.page_no} 页</strong><p>{r.text}</p></div>
      <button className="cs-icon" aria-label="加入出处" disabled={refs.length >= 8} onClick={() => setRefs([...refs, { ...r, text: (r.text || '').slice(0, 400) }])}><Plus size={15} /></button></li>)}</ul></>}
    <h3>寄语 <small>观众定制时可选，最多 6 句</small></h3>
    <div className="cs-greetings">{greetings.map((g, i) => <div key={i}><input maxLength={48} value={g} onChange={event => setGreetings(greetings.map((x, n) => n === i ? event.target.value : x))} />
      <button className="cs-icon" aria-label="删除寄语" onClick={() => setGreetings(greetings.filter((_, n) => n !== i))}><X size={15} /></button></div>)}
      {greetings.length < 6 && <button className="cs-button" onClick={() => setGreetings([...greetings, ''])}><Plus size={15} />添加寄语</button>}</div>
    <div className="cs-actions"><button className="cs-primary" disabled={!!ctx.busy} onClick={() => void ctx.save({ hook: hook.trim(), story: story.trim(), story_refs: refs, greetings: greetings.map(g => g.trim()).filter(Boolean) })}>保存文案</button></div>
  </div>
}

// ------------------------------------------------------------------ 7 成品

function CropBox({ src, value, onChange, round = false }: { src: string; value: number[] | null; onChange: (box: number[]) => void; round?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), drag = useRef<{ mode: 'new' | 'move'; x: number; y: number; box: number[] } | null>(null)
  const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
  const at = (event: ReactPointerEvent) => { const r = ref.current!.getBoundingClientRect(); return [clamp((event.clientX - r.left) / r.width), clamp((event.clientY - r.top) / r.height)] }
  const fix = (box: number[]) => box.map(v => Math.round(v * 10000) / 10000)
  const down = (event: ReactPointerEvent) => {
    event.preventDefault(); ref.current!.setPointerCapture(event.pointerId)
    const [x, y] = at(event), box = value || [0, 0, 1, 1]
    drag.current = { mode: value && x > box[0] && x < box[2] && y > box[1] && y < box[3] ? 'move' : 'new', x, y, box }
  }
  const move = (event: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const [x, y] = at(event)
    if (d.mode === 'new') onChange(fix([Math.min(d.x, x), Math.min(d.y, y), Math.max(d.x, x), Math.max(d.y, y)]))
    else {
      const w = d.box[2] - d.box[0], h = d.box[3] - d.box[1], nx = clamp(d.box[0] + x - d.x, 0, 1 - w), ny = clamp(d.box[1] + y - d.y, 0, 1 - h)
      onChange(fix([nx, ny, nx + w, ny + h]))
    }
  }
  const up = (event: ReactPointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || d.mode !== 'new') return
    const [x, y] = at(event)
    if (Math.abs(x - d.x) < .03 || Math.abs(y - d.y) < .03) onChange(d.box)
  }
  const box = value || [0, 0, 1, 1]
  return <div className="cs-crop cs-paper" ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null }}>
    <img src={src} alt="" draggable={false} />
    <i className={round ? 'round' : ''} style={{ left: box[0] * 100 + '%', top: box[1] * 100 + '%', width: (box[2] - box[0]) * 100 + '%', height: (box[3] - box[1]) * 100 + '%' }} />
  </div>
}

function ProductsStep({ ctx }: { ctx: Ctx }) {
  const { theme, venue } = ctx
  const [palette, setPalette] = useState<Palette>(theme.palette), [emoji, setEmoji] = useState<Sticker[]>(theme.emoji)
  const [avatar, setAvatar] = useState<number[] | null>(theme.avatar_crop), [editing, setEditing] = useState<number | 'avatar'>(0)
  const dirty = palette !== theme.palette || JSON.stringify(emoji) !== JSON.stringify(theme.emoji) || JSON.stringify(avatar) !== JSON.stringify(theme.avatar_crop)
  const stale = !theme.steps.find(s => s.key === 'products')?.done
  const line = theme.art.line
  const render = () => ctx.run('render', async () => {
    if (dirty) ctx.apply(await studioApi.update(theme.id, { palette, emoji, avatar_crop: avatar }))
    ctx.apply(await studioApi.render(theme.id))
  }, '成品已渲染')
  return <div className="cs-form">
    <Field label="默认配色" hint="观众可以再换"><div className="cs-swatches">{(Object.keys(PALETTE_NAMES) as Palette[]).map(key => { const p = venue?.palettes[key]; return <button key={key} aria-pressed={palette === key} onClick={() => setPalette(key)}>
      <i style={{ background: p && `linear-gradient(135deg, ${p.bg} 0 54%, ${p.accent} 54%)`, borderColor: p?.bg }} />{PALETTE_NAMES[key]}</button> })}</div></Field>
    <h3>表情包 <small>从线描上框出人物，配 1–6 字短语；最多 6 个</small></h3>
    {line ? <div className="cs-crop-grid">
      <CropBox src={line} value={editing === 'avatar' ? avatar : emoji[editing]?.crop || null} round={editing === 'avatar'}
        onChange={box => editing === 'avatar' ? setAvatar(box) : emoji[editing] && setEmoji(emoji.map((s, i) => i === editing ? { ...s, crop: box } : s))} />
      <div className="cs-stickers">
        {emoji.map((s, i) => <div key={i} className={editing === i ? 'active' : ''} onClick={() => setEditing(i)}>
          <b>{i + 1}</b><input maxLength={6} value={s.phrase} aria-label={`表情 ${i + 1} 短语`} onFocus={() => setEditing(i)} onChange={event => setEmoji(emoji.map((x, n) => n === i ? { ...x, phrase: event.target.value } : x))} />
          <label className="cs-check"><input type="checkbox" checked={!!s.accent} onChange={event => setEmoji(emoji.map((x, n) => n === i ? { ...x, accent: event.target.checked } : x))} />朱砂色</label>
          <button className="cs-icon" aria-label="删除表情" onClick={event => { event.stopPropagation(); setEmoji(emoji.filter((_, n) => n !== i)); setEditing(0) }}><X size={14} /></button></div>)}
        {emoji.length < 6 && <button className="cs-button" onClick={() => { setEmoji([...emoji, { phrase: '', crop: [0, 0, 1, 1] }]); setEditing(emoji.length) }}><Plus size={15} />添加表情</button>}
        <div className={'cs-avatar-row' + (editing === 'avatar' ? ' active' : '')} onClick={() => setEditing('avatar')}><b>头像</b><span>{avatar ? '已框选' : '使用整幅线描'}</span>
          {avatar && <button className="cs-link" onClick={event => { event.stopPropagation(); setAvatar(null) }}>恢复整幅</button>}</div>
        <p className="cs-hint">选中左侧某一项后，在线描上拖动框选；拖动框内可平移。</p>
      </div>
    </div> : <p className="cs-hint">选定线描并渲染一次后，才能框选表情和头像。</p>}
    <div className="cs-actions">
      {dirty && <button className="cs-button" disabled={!!ctx.busy || emoji.some(s => !s.phrase.trim())} onClick={() => void ctx.save({ palette, emoji: emoji.map(s => ({ ...s, phrase: s.phrase.trim() })), avatar_crop: avatar })}>只保存</button>}
      <button className="cs-primary" disabled={!!ctx.busy || emoji.some(s => !s.phrase.trim())} onClick={() => void render()}>{ctx.busy === 'render' ? <><LoaderCircle className="cs-spin" size={15} />渲染中，约一分钟</> : <><RotateCw size={15} />{dirty ? '保存并渲染' : stale ? '渲染成品' : '重新渲染'}</>}</button>
    </div>
    {theme.products.length > 0 && <><h3>成品预览 <small>{theme.rendered_at ? '渲染于 ' + new Date(theme.rendered_at).toLocaleString('zh-CN') : ''}{stale && ' · 内容有改动，需要重新渲染'}</small></h3>
      <div className="cs-products">{theme.products.map(p => <a key={p.id} href={p.files[0]?.url} target="_blank" rel="noreferrer" className={'cs-product cs-product-' + p.id}>
        <span>{p.id === 'emoji' ? p.files.map(f => <img key={f.name} src={f.url} alt="" />) : <img src={p.thumb_url} alt="" />}</span><strong>{p.title}</strong><small>{p.files.length > 1 ? `${p.files.length} 个文件` : p.files[0]?.width ? `${p.files[0].width}×${p.files[0].height}` : ''}</small></a>)}</div></>}
  </div>
}

// ------------------------------------------------------------------ 8 上架

function PublishStep({ ctx }: { ctx: Ctx }) {
  const { theme, venue } = ctx
  const [hall, setHall] = useState(theme.hall?.id || '')
  const pending = theme.steps.slice(0, 6).filter(s => !s.done)
  const published = theme.status === 'published'
  return <div className="cs-form">
    <ul className="cs-list">{theme.steps.slice(0, 7).map(s => <li key={s.key}><span className={'cs-dot ' + (s.done ? 'ok' : s.optional ? '' : 'warn')} /><strong>{s.title}</strong><small>{s.detail}</small></li>)}</ul>
    <Field label="所属展厅" hint="决定观众端显示的章节，也用于展厅海报"><select value={hall} onChange={event => { setHall(event.target.value); void ctx.save({ hall: event.target.value || null }, '展厅已保存') }}>
      <option value="">未指定</option>{venue?.halls.map(h => <option key={h.id} value={h.id}>{h.name} · {h.chapter}</option>)}</select></Field>
    {pending.length > 0 && !published && <p className="cs-hint warn">还需完成：{pending.map(s => s.title).join('、')}</p>}
    <div className="cs-actions left">
      {published ? <button className="cs-button" disabled={!!ctx.busy} onClick={() => void ctx.run('publish', async () => ctx.apply(await studioApi.publish(theme.id, false)), '已下架')}>下架</button>
        : <button className="cs-primary" disabled={!!ctx.busy || pending.length > 0 || !hall} onClick={() => void ctx.run('publish', async () => ctx.apply(await studioApi.publish(theme.id, true)), '已上架，观众端可以看到了')}>
          {ctx.busy === 'publish' ? <LoaderCircle className="cs-spin" size={15} /> : <Check size={15} />}上架</button>}
    </div>
    {published && <div className="cs-share"><img src={`/api/creative/themes/${theme.id}/qr?v=${theme.updated_at}`} alt="主题二维码" /><div>
      <strong>观众入口</strong><code>{theme.theme_url}</code><span className="cs-hint">可以印在展厅说明牌上；手机连接场馆 Wi-Fi 后扫码直达这个故事。</span>
      <button className="cs-button" onClick={() => goToSection('creative', { theme: theme.id, ct: null, creative_tab: null })}>打开观众页<ArrowUpRight size={14} /></button></div></div>}
  </div>
}
