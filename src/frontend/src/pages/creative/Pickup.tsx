import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from 'lucide-react'
import { creativeApi, type Pickup, type StampBook as Book, type Work } from '../../lib/creativeApi'
import { Dialog, Media, go, replace, saveHint, withDownload } from './shared'

/** Opened on a phone from the kiosk's take-away code. */
export function PickupPage({ token }: { token: string }) {
  const [value, setValue] = useState<Pickup | null>(null), [error, setError] = useState('')
  useEffect(() => { creativeApi.pickup(token).then(setValue).catch(reason => setError(reason.message)) }, [token])
  if (!value) return <div className="cw-page"><div className="cw-empty cw-center">{error || <><LoaderCircle className="cw-spin" size={28} />正在打开</>}</div></div>
  const video = value.files.find(f => f.kind === 'video')
  return <div className="cw-page cw-pickup">
    <p className="cw-eyebrow">武氏墓群石刻 · 电子文创</p>
    <h1>{value.theme.title}</h1><p className="cw-use">{value.product_title} · 请现场保存到手机</p>
    <div className={'cw-pickup-files' + (value.files.length > 2 ? ' is-grid' : '')}>{value.files.map(file => <figure key={file.name}>
      <Media file={file} alt={value.product_title} poster={video && file.kind === 'video' ? value.files.find(f => f.kind === 'image')?.url : undefined} />
      <a className={file.kind === 'video' || value.files.length === 1 ? 'cw-primary' : 'cw-button'} href={withDownload(file.url)} download>{file.kind === 'video' ? '保存视频' : '保存'}</a>
    </figure>)}</div>
    <p className="cw-hint">{saveHint(video ? 'video' : 'image')}</p>
    <p className="cw-note">这个页面只在场馆网络内有效，{new Date(value.expires_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 后失效。</p>
    <button className="cw-link" onClick={() => go({ theme: value.theme.id })}>看看「{value.theme.title}」的故事<ArrowRight size={16} /></button>
  </div>
}

function Seal({ text, on }: { text: string; on: boolean }) {
  return <span className={'cw-seal' + (on ? ' on' : '')} aria-hidden="true">{text.split('').map((c, i) => <b key={i}>{c}</b>)}</span>
}

/** Hall stamp book; a signed QR code at each hall adds one seal. */
export function StampBook({ hall, code }: { hall: string; code: string }) {
  const [book, setBook] = useState<Book | null>(null), [error, setError] = useState(''), [fresh, setFresh] = useState('')
  const claimed = useRef('')
  useEffect(() => {
    const key = hall + ':' + code
    if (hall && code && claimed.current !== key) {
      claimed.current = key
      creativeApi.collect(hall, code).then(value => { setBook(value); if (value.fresh) setFresh(value.hall || ''); replace({ stamps: '1' }) })
        .catch(reason => { setError(reason.message); replace({ stamps: '1' }) })
    } else if (!hall) creativeApi.stamps().then(setBook).catch(reason => setError(reason.message))
  }, [hall, code])
  const stamped = book?.halls.find(h => h.id === fresh)
  return <div className="cw-page cw-stamps">
    <div className="cw-bar"><button className="cw-back" onClick={() => go()}><ArrowLeft size={20} />全部故事</button></div>
    <p className="cw-eyebrow">汉画寻踪</p><h1>集章</h1>
    <p className="cw-use">传承中心七个展厅各有一枚集章二维码。用手机相机扫码，就会在这里盖下这个展厅的印章；集齐七枚，可以领取集章纪念卡。</p>
    {stamped && <div className="cw-stamp-fresh" role="status"><Seal text={stamped.seal} on /><div><strong>已盖下「{stamped.name}」印章</strong><span>{stamped.chapter}</span></div></div>}
    {error && <p className="cw-error" role="alert">{error}</p>}
    {book ? <>
      <div className="cw-seals">{book.halls.map(h => { const on = book.collected.includes(h.id); return <div key={h.id} className={on ? 'on' : ''}><Seal text={h.seal} on={on} /><strong>{h.name}</strong><small>{on ? '已盖章' : h.chapter}</small></div> })}</div>
      <p className="cw-count">已集 {book.collected.length} / {book.halls.length} 枚</p>
      {book.complete && book.card_url && <section className="cw-stamp-card"><h2><Check size={20} />七枚集齐</h2><img src={book.card_url} alt="集章纪念卡" />
        <a className="cw-primary" href={withDownload(book.card_url)} download>保存集章纪念卡</a><p className="cw-hint">{saveHint('image')}</p></section>}
      <p className="cw-note">印章记录保存在这台手机的浏览器里，30 天内有效；换手机或清除浏览器数据后需要重新集章。</p>
    </> : !error && <div className="cw-empty"><LoaderCircle className="cw-spin" size={26} /></div>}
  </div>
}

/** Works made on this phone in the last three days. */
export function MyWorks({ onClose }: { onClose: () => void }) {
  const [works, setWorks] = useState<Work[] | null>(null), [error, setError] = useState('')
  useEffect(() => { creativeApi.works().then(setWorks).catch(reason => setError(reason.message)) }, [])
  return <Dialog label="我的作品" onClose={onClose} className="cw-works">
    <p className="cw-note">这台手机最近 3 天做的作品。离开场馆后无法打开，请及时保存。</p>
    {works ? works.length ? <div className="cw-works-grid">{works.map(w => { const video = w.files.find(f => f.kind === 'video'), image = w.files.find(f => f.kind === 'image'); return <article key={w.id}>
      {image ? <img src={image.thumb_url} alt={w.title} /> : <div className="cw-empty">{w.status === 'failed' ? w.error || '制作失败' : '制作中'}</div>}
      <strong>{w.title}</strong>
      <div>{video && <a className="cw-button" href={withDownload(video.url)} download>保存视频</a>}{image && <a className="cw-button" href={withDownload(image.url)} download>保存图片</a>}</div>
    </article> })}</div> : <div className="cw-empty">还没有做过作品</div> : <div className="cw-empty">{error || <LoaderCircle className="cw-spin" size={24} />}</div>}
  </Dialog>
}
