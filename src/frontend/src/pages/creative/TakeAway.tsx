import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, LoaderCircle, Printer, QrCode, RotateCcw, Sparkles } from 'lucide-react'
import { creativeApi, PALETTE_NAMES, type CustomProduct, type Design, type Palette, type PrintTicket, type Product, type Theme, type Venue, type Work } from '../../lib/creativeApi'
import { HandoffDialog, Media, SaveActions, go, saveHint, withDownload } from './shared'

const draftKey = (theme: string, product: string) => `wsc.creative.draft.${theme}.${product}`

function initialDesign(theme: Theme, product: CustomProduct): Design {
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftKey(theme.id, product)) || 'null')
    if (saved?.theme === theme.id && saved.product === product) return saved
  } catch { /* A fresh design is fine. */ }
  return { theme: theme.id, product, palette: theme.palette, art: theme.color_count && product !== 'avatar' ? 'color' : 'line', variant: 0,
    greeting: theme.greetings[0] || '', signature: '', motion: false }
}

export default function TakeAway({ theme, product, venue, kiosk }: { theme: Theme; product: Product; venue: Venue | null; kiosk: boolean }) {
  const custom = product.customizable ? product.id as CustomProduct : null
  const stickers = product.id === 'emoji'
  const [editing, setEditing] = useState(false)
  const [design, setDesign] = useState<Design | null>(() => custom ? initialDesign(theme, custom) : null)
  const [preview, setPreview] = useState(''), [previewing, setPreviewing] = useState(false)
  const [work, setWork] = useState<Work | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [handoff, setHandoff] = useState<{ work_id?: string; theme?: string; product?: Product['id'] } | null>(null)
  const [ticket, setTicket] = useState<PrintTicket | null>(null)
  const requestRef = useRef<{ id: string; key: string } | null>(null), sending = useRef(false)
  const patch = (value: Partial<Design>) => { setDesign(d => d && { ...d, ...value }); setWork(null) }

  useEffect(() => {
    if (!design || kiosk) return
    try { sessionStorage.setItem(draftKey(theme.id, design.product), JSON.stringify(design)) } catch { /* Drafts are a convenience. */ }
  }, [design])
  useEffect(() => {
    if (!editing || !design) return
    const controller = new AbortController()
    setPreviewing(true)
    const timer = window.setTimeout(() => {
      creativeApi.preview({ ...design, motion: false }, controller.signal).then(value => setPreview(value.image))
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message) }).finally(() => { if (!controller.signal.aborted) setPreviewing(false) })
    }, 280)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [editing, design])
  useEffect(() => {
    if (!work || !['queued', 'rendering'].includes(work.status)) return
    const timer = window.setInterval(() => { creativeApi.work(work.id).then(setWork).catch(reason => setError(reason.message)) }, 1200)
    return () => window.clearInterval(timer)
  }, [work?.id, work?.status])

  const make = async () => {
    if (!design || sending.current) return
    sending.current = true; setBusy(true); setError('')
    const key = JSON.stringify(design)
    if (requestRef.current?.key !== key) requestRef.current = { id: crypto.randomUUID(), key }
    try { setWork(await creativeApi.createWork(requestRef.current.id, design)) }
    catch (reason) { setError((reason as Error).message) }
    finally { setBusy(false); sending.current = false }
  }
  const print = async () => {
    setError('')
    try { setTicket(await creativeApi.print(work?.status === 'succeeded' ? { work_id: work.id } : { theme: theme.id, product: stickers ? 'emoji' : 'postcard' })) }
    catch (reason) { setError((reason as Error).message) }
  }

  const done = work?.status === 'succeeded' ? work : null
  const files = done ? done.files : product.files
  const art = ({ color: theme.color_count > 1 ? '彩色演绎一' : '彩色演绎', line: theme.line_kind === 'rubbing' ? '拓片' : '线描' })
  const artChoices: [Design['art'], number, string][] = [
    ...(theme.color_count ? [['color', 0, art.color] as [Design['art'], number, string]] : []),
    ...(theme.color_count > 1 ? [['color', 1, '彩色演绎二'] as [Design['art'], number, string]] : []),
    ['line', 0, art.line],
  ]
  const video = files.find(f => f.kind === 'video')
  const cover = files.find(f => f.kind === 'image')
  const pending = work && ['queued', 'rendering'].includes(work.status)
  const ratio = product.files[0]?.width && product.files[0]?.height ? product.files[0].width / product.files[0].height : 1

  return <div className="cw-take">
    <div className="cw-bar"><button className="cw-back" onClick={() => go({ theme: theme.id })}><ArrowLeft size={20} />{theme.title}</button><span>{product.title}</span></div>
    <div className={`cw-take-body cw-take-${product.id}`}>
      <div className="cw-take-art" style={{ ['--ratio' as string]: String(ratio) }}>
        {stickers && !done ? <div className="cw-stickers">{files.map((f, i) => <figure key={f.name}><img src={f.url} alt={`表情 ${i + 1}`} />
          {!kiosk && <a className="cw-button" href={withDownload(f.url)} download>保存</a>}</figure>)}</div>
          : editing && !done ? <div className="cw-take-frame">{preview ? <img src={preview} alt="我的版本预览" /> : <img src={product.files[0].thumb_url} alt="" />}{previewing && <span className="cw-busy"><LoaderCircle className="cw-spin" size={24} /></span>}</div>
          : <div className="cw-take-frame">{video ? <Media file={video} alt={product.title} poster={cover?.url} /> : cover && <img src={cover.url} alt={`${theme.title} · ${product.title}`} />}</div>}
      </div>
      <aside className="cw-take-panel">
        <p className="cw-eyebrow">{theme.title}</p>
        <h1>{done ? '你的版本做好了' : product.title}</h1>
        <p className="cw-use">{done ? '保存后就是你独有的一件汉画文创。' : product.use}</p>
        {pending && <div className="cw-progress" role="status"><LoaderCircle className="cw-spin" size={20} />{work!.status === 'queued' && work!.ahead ? `正在排队，前面还有 ${work!.ahead} 件` : work!.design.motion ? '正在合成动态明信片，约半分钟' : '正在制作'}</div>}
        {work?.status === 'failed' && <p className="cw-error" role="alert">{work.error || '制作失败，请再试一次'}</p>}
        {!pending && (kiosk
          ? <button className="cw-primary cw-wide" onClick={() => setHandoff(done ? { work_id: done.id } : { theme: theme.id, product: product.id })}><QrCode size={22} />扫码带走</button>
          : stickers && !done ? <p className="cw-hint">{saveHint('image')}</p> : <SaveActions files={files} title={product.title} />)}
        {venue?.print_enabled && product.printable && !pending && (!done || done.design.product === 'postcard') && (ticket
          ? <div className="cw-ticket" role="status"><Check size={20} /><div><strong>取件号 {ticket.number}</strong><span>请到文创展区服务台领取打印的{stickers ? '表情贴纸' : '明信片'}</span></div></div>
          : <button className="cw-button cw-wide" onClick={() => void print()}><Printer size={19} />{stickers ? '打印成一张贴纸' : '打印这张明信片'}</button>)}
        {error && <p className="cw-error" role="alert">{error}</p>}

        {custom && design && (!editing ? <button className="cw-link" onClick={() => setEditing(true)}><Sparkles size={18} />自己改一改：换配色、写寄语、署名</button>
          : <section className="cw-custom" aria-label="自己改一改">
            <div className="cw-custom-head"><h2>自己改一改</h2>{done && <button className="cw-link" onClick={() => setWork(null)}><RotateCcw size={16} />继续修改</button>}</div>
            <div className="cw-field"><span>配色</span><div className="cw-swatches">{(Object.keys(PALETTE_NAMES) as Palette[]).map(key => { const p = venue?.palettes[key]; return <button key={key} aria-pressed={design.palette === key} onClick={() => patch({ palette: key })}>
              <i style={{ background: p && `linear-gradient(135deg, ${p.bg} 0 54%, ${p.accent} 54%)`, color: p?.ink, borderColor: p?.bg }}>{design.palette === key && <Check size={16} />}</i>{PALETTE_NAMES[key]}</button> })}</div></div>
            <div className="cw-field"><span>图案</span><div className="cw-chips">{artChoices.map(([a, v, label]) => <button key={label} aria-pressed={design.art === a && (a === 'line' || design.variant === v)} onClick={() => patch({ art: a, variant: v })}>{label}</button>)}</div></div>
            {custom !== 'avatar' && <div className="cw-field"><span>寄语</span>
              <div className="cw-chips">{theme.greetings.map(g => <button key={g} aria-pressed={design.greeting === g} onClick={() => patch({ greeting: g })}>{g}</button>)}</div>
              <input maxLength={48} value={design.greeting} placeholder="也可以自己写一句" aria-label="寄语" onChange={event => patch({ greeting: event.target.value })} /></div>}
            {custom !== 'avatar' && <label className="cw-field"><span>署名</span><input maxLength={12} value={design.signature} placeholder="写上你的名字，可不填" onChange={event => patch({ signature: event.target.value })} /></label>}
            {custom === 'postcard' && theme.has_video && <label className="cw-toggle"><input type="checkbox" checked={design.motion} onChange={event => patch({ motion: event.target.checked })} />做成五秒动态明信片<small>预览为静态，生成后播放</small></label>}
            <button className="cw-primary cw-wide" disabled={busy || !!pending || !!done} onClick={() => void make()}>{busy ? <LoaderCircle className="cw-spin" size={20} /> : <Sparkles size={20} />}{done ? '已生成' : '生成我的版本'}</button>
          </section>)}
        <p className="cw-provenance">{stickers
          ? <>表情取自这块石头的{theme.line_kind === 'rubbing' ? '拓片' : '线描'}，出自「武氏墓群石刻 · {theme.stone_id} {theme.stone_name}」{venue?.print_enabled ? '；打印的贴纸页底部印有出处和回到文物档案的二维码' : ''}。</>
          : <>每件成品底部都印有出处「武氏墓群石刻 · {theme.stone_id} {theme.stone_name}」和回到文物档案的二维码{theme.color_count ? '，彩色图注明“艺术演绎”' : ''}。</>}</p>
      </aside>
    </div>
    {handoff && <HandoffDialog target={handoff} venue={venue} onClose={() => setHandoff(null)} />}
  </div>
}
