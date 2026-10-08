import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Images, LoaderCircle, Stamp, Wifi } from 'lucide-react'
import { creativeApi, type Theme, type Venue } from '../lib/creativeApi'
import { goToSection, openDocument } from '../lib/navigation'
import { go, readParams, type CreativeParams } from './creative/shared'
import TakeAway from './creative/TakeAway'
import { MyWorks, PickupPage, StampBook } from './creative/Pickup'
import ScreenLoop from './creative/Screen'
import './CreativePage.css'

const KIOSK_FLAG = 'wsc.kiosk'

/** A kiosk stays a kiosk for the whole browser session; `kiosk=0` turns it off again. */
function useKiosk(requested: boolean) {
  const [kiosk] = useState(() => {
    try {
      if (new URLSearchParams(location.hash.slice(1)).get('kiosk') === '0') sessionStorage.removeItem(KIOSK_FLAG)
      else if (requested) sessionStorage.setItem(KIOSK_FLAG, '1')
      return requested || sessionStorage.getItem(KIOSK_FLAG) === '1'
    } catch { return requested }
  })
  useEffect(() => {
    if (!kiosk) return
    document.documentElement.dataset.kiosk = '1'
    const block = (event: Event) => event.preventDefault()
    window.addEventListener('contextmenu', block)
    return () => { delete document.documentElement.dataset.kiosk; window.removeEventListener('contextmenu', block) }
  }, [kiosk])
  return kiosk
}

function useParams() {
  const [params, setParams] = useState<CreativeParams>(readParams)
  useEffect(() => {
    const sync = () => setParams(readParams())
    window.addEventListener('hashchange', sync); window.addEventListener('popstate', sync)
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync) }
  }, [])
  return params
}

export default function CreativePage() {
  const params = useParams()
  return params.screen ? <ScreenLoop /> : <VisitorPage params={params} />
}

function VisitorPage({ params }: { params: CreativeParams }) {
  const kiosk = useKiosk(params.kiosk)
  const [venue, setVenue] = useState<Venue | null>(null)
  const [themes, setThemes] = useState<Theme[] | null>(null), [error, setError] = useState('')
  const [generation, setGeneration] = useState(0), [attract, setAttract] = useState(kiosk)
  const load = useCallback(() => {
    setError('')
    creativeApi.venue().then(setVenue).catch(() => undefined)
    creativeApi.themes().then(setThemes).catch(reason => setError(reason.message))
  }, [])
  useEffect(load, [load])
  useEffect(() => { document.querySelector('.cw-root')?.scrollTo({ top: 0 }) }, [params.theme, params.product, params.take, params.stamps])

  // Resetting forgets everything the last visitor did: their works, drafts and open dialogs.
  const reset = useCallback(async () => {
    await creativeApi.reset().catch(() => undefined)
    try { Object.keys(sessionStorage).filter(key => key.startsWith('wsc.creative.')).forEach(key => sessionStorage.removeItem(key)) } catch { /* nothing kept */ }
    setGeneration(n => n + 1); go(); setAttract(true); load()
  }, [load])

  let body
  if (params.take) body = <PickupPage token={params.take} />
  else if (params.stamp || params.stamps) body = <StampBook hall={params.stamp} code={params.code} />
  else if (params.theme) body = <ThemeView id={params.theme} product={params.product} venue={venue} kiosk={kiosk} />
  else body = <Wall themes={themes} error={error} venue={venue} kiosk={kiosk} onRetry={load} />

  return <div className={'cw-root' + (kiosk ? ' is-kiosk' : '')}>
    <div key={generation} className="cw-scroll">{body}</div>
    {params.mine && !kiosk && <MyWorks onClose={() => go()} />}
    {kiosk && <KioskIdle seconds={venue?.idle_seconds || 90} paused={attract} onReset={reset} />}
    {kiosk && attract && <Attract themes={themes || []} onStart={() => setAttract(false)} />}
  </div>
}

function Wall({ themes, error, venue, kiosk, onRetry }: { themes: Theme[] | null; error: string; venue: Venue | null; kiosk: boolean; onRetry: () => void }) {
  return <div className="cw-page cw-wall-page">
    <section className="cw-hero">
      <p className="cw-eyebrow">武氏墓群石刻 · 电子文创</p>
      <h1>把一个汉画故事带回家</h1>
      <ol className="cw-steps">
        <li><b>一</b><span>挑一个石头上的故事</span></li>
        <li><b>二</b><span>对照原石拓片看懂它</span></li>
        <li><b>三</b><span>把壁纸、明信片存进手机</span></li>
      </ol>
      {!kiosk && <p className="cw-lan"><Wifi size={16} />本页只在传承中心的场馆网络内可用，离开前请把喜欢的作品保存到手机。</p>}
    </section>
    {themes ? themes.length ? <div className="cw-wall">{themes.map((theme, index) =>
      <button key={theme.id} className="cw-card" style={{ ['--i' as string]: index }} onClick={() => go({ theme: theme.id })}>
        <span className="cw-card-art">{theme.cover_url && <img src={theme.cover_url} alt="" loading="lazy" />}</span>
        <span className="cw-card-text">
          <small>{[theme.hall?.name, theme.stone_name].filter(Boolean).join(' · ')}</small>
          <strong>{theme.title}</strong>
          <em>{theme.hook}</em>
        </span>
        <ArrowRight className="cw-card-go" size={20} />
      </button>)}</div>
      : <div className="cw-empty">故事正在整理中，敬请期待</div>
      : <div className="cw-empty">{error ? <>{error}<button className="cw-button" onClick={onRetry}>重试</button></> : <><LoaderCircle className="cw-spin" size={26} />正在载入</>}</div>}
    <div className="cw-extras">
      {kiosk ? <>
        <div className="cw-extra cw-phone">
          {venue && <img src={venue.home_qr} alt="用手机打开电子文创的二维码" />}
          <div><strong>用手机继续逛</strong><span>{venue?.wifi_ssid ? `先连接场馆 Wi-Fi「${venue.wifi_ssid}」，再用相机扫码` : '连接场馆 Wi-Fi 后，用相机扫码'}</span></div>
          {venue?.wifi_qr && <figure><img src={venue.wifi_qr} alt="连接场馆 Wi-Fi 的二维码" /><figcaption>扫码连 Wi-Fi</figcaption></figure>}
        </div>
        <div className="cw-extra"><Stamp size={30} /><div><strong>汉画寻踪 · 集章</strong><span>七个展厅各有一枚集章二维码，用手机扫码盖章，集齐可领纪念卡</span></div></div>
      </> : <>
        <button className="cw-extra" onClick={() => go({ stamps: '1' })}><Stamp size={30} /><div><strong>汉画寻踪 · 集章</strong><span>在七个展厅扫码盖章，集齐领取纪念卡</span></div><ArrowRight size={20} /></button>
        <button className="cw-extra" onClick={() => go({ mine: '1' })}><Images size={30} /><div><strong>我的作品</strong><span>这台手机最近 3 天做的作品</span></div><ArrowRight size={20} /></button>
      </>}
    </div>
  </div>
}

function ThemeView({ id, product, venue, kiosk }: { id: string; product: string; venue: Venue | null; kiosk: boolean }) {
  const [theme, setTheme] = useState<Theme | null>(null), [error, setError] = useState('')
  const counted = useRef('')
  useEffect(() => {
    setError('')
    const view = counted.current !== id
    counted.current = id
    creativeApi.theme(id, view).then(setTheme).catch(reason => setError(reason.message))
  }, [id])
  if (!theme || theme.id !== id) return <div className="cw-page"><div className="cw-bar"><button className="cw-back" onClick={() => go()}><ArrowLeft size={20} />全部故事</button></div>
    <div className="cw-empty cw-center">{error || <><LoaderCircle className="cw-spin" size={28} />正在打开</>}</div></div>
  const chosen = theme.products.find(p => p.id === product)
  return chosen ? <TakeAway key={chosen.id} theme={theme} product={chosen} venue={venue} kiosk={kiosk} /> : <ThemePage theme={theme} kiosk={kiosk} />
}

type View = { key: string; label: string; note: string; url: string; video?: boolean; evidence?: boolean }

function views(theme: Theme): View[] {
  const list: View[] = []
  if (theme.art.original) list.push({ key: 'original', label: '原石拓片', note: `${theme.stone_name}拓片局部，这个故事的依据`, url: theme.art.original, evidence: true })
  if (theme.art.line) list.push(theme.line_kind === 'rubbing'
    ? { key: 'line', label: '拓片底稿', note: '按原石拓片整理的底稿', url: theme.art.line, evidence: true }
    : { key: 'line', label: '线描', note: '据原石拓片勾出的线描，人物、器物已与原石逐项核对', url: theme.art.line, evidence: true })
  theme.art.colors.forEach((url, i) => list.push({ key: 'color' + i, label: theme.art.colors.length > 1 ? `彩色演绎${'一二'[i] || i + 1}` : '彩色演绎', note: `以${theme.line_kind === 'rubbing' ? '拓片' : '线描'}为底稿的艺术演绎，颜色是今天的想象，汉代原石没有这些色彩`, url }))
  if (theme.art.clip) list.push({ key: 'clip', label: '动态短片', note: '五秒动态演绎，属于艺术再创作', url: theme.art.clip, video: true })
  return list
}

function ThemePage({ theme, kiosk }: { theme: Theme; kiosk: boolean }) {
  const list = views(theme)
  const [active, setActive] = useState(list[0]?.key || '')
  const view = list.find(v => v.key === active) || list[0]
  return <div className="cw-page cw-theme">
    <div className="cw-bar"><button className="cw-back" onClick={() => go()}><ArrowLeft size={20} />全部故事</button>{theme.hall && <span>{theme.hall.name} · {theme.hall.chapter}</span>}</div>
    <header className="cw-theme-head">
      <p className="cw-eyebrow">{theme.stone_id} · {theme.stone_name}</p>
      <h1>{theme.title}</h1>
      <p className="cw-hook">{theme.hook}</p>
    </header>
    <div className="cw-theme-body">
      <section className="cw-viewer" aria-label="原石与演绎对照">
        <div className="cw-viewer-stage">{view && (view.video
          ? <video key={view.url} src={view.url} poster={theme.art.colors[0]} controls playsInline loop muted autoPlay />
          : <img key={view.url} src={view.url} alt={`${theme.title} · ${view.label}`} />)}
          {view && <span className={'cw-tag' + (view.evidence ? ' is-evidence' : '')}>{view.evidence ? '依据' : '艺术演绎'}</span>}
        </div>
        <div className="cw-viewer-tabs" role="tablist">{list.map(v => <button key={v.key} role="tab" aria-selected={v.key === view?.key} onClick={() => setActive(v.key)}>
          {v.video ? <span className="cw-tab-video">▶</span> : <img src={v.url} alt="" />}<span>{v.label}</span></button>)}</div>
        {view && <p className="cw-viewer-note">{view.note}</p>}
      </section>
      <section className="cw-story">
        <h2>石头上的故事</h2>
        <p className="cw-story-text">{theme.story}</p>
        {theme.story_refs.length > 0 && <div className="cw-refs"><h3><BookOpen size={17} />故事出处</h3>
          {theme.story_refs.map((ref, i) => <blockquote key={i}>
            <p>{ref.text.length > 90 ? ref.text.slice(0, 90) + '…' : ref.text}</p>
            <footer><cite>《{ref.document_title}》第 {ref.page_no} 页</cite>
              {!kiosk && <button className="cw-link" onClick={() => openDocument({ collection: 'core', documentId: ref.document_id, pageNo: ref.page_no })}>看原书<ArrowUpRight size={14} /></button>}</footer>
          </blockquote>)}
        </div>}
        {!kiosk && <button className="cw-link cw-archive" onClick={() => goToSection('archive', { stone: theme.stone_id, theme: null, product: null })}>在文物档案里看「{theme.stone_name}」的全部画面<ArrowUpRight size={16} /></button>}
      </section>
    </div>
    <section className="cw-products" aria-label="带走它">
      <h2>带走它</h2>
      <p className="cw-use">{kiosk ? '选一件，用手机扫码就能带走' : '选一件，保存到手机'}，每件成品都印着这块石头的出处。</p>
      <div className="cw-product-grid">{theme.products.map(p => <button key={p.id} className={'cw-product cw-product-' + p.id} onClick={() => go({ theme: theme.id, product: p.id })}>
        <span className="cw-product-art"><img src={p.thumb_url} alt="" loading="lazy" />{p.id === 'postcard_video' && <i className="cw-play">▶</i>}</span>
        <strong>{p.title}</strong><small>{p.use}</small>
      </button>)}</div>
    </section>
  </div>
}

/** Counts down after a visitor walks away, then hands the screen to the next one. */
function KioskIdle({ seconds, paused, onReset }: { seconds: number; paused: boolean; onReset: () => void }) {
  const [left, setLeft] = useState<number | null>(null)
  const last = useRef(Date.now()), dirty = useRef(false), resetRef = useRef(onReset)
  resetRef.current = onReset
  useEffect(() => {
    const touch = () => { last.current = Date.now(); dirty.current = true; setLeft(null) }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach(name => window.addEventListener(name, touch, { capture: true, passive: true }))
    const timer = window.setInterval(() => {
      if (!dirty.current) return
      const idle = (Date.now() - last.current) / 1000
      if (idle >= seconds) { dirty.current = false; setLeft(null); resetRef.current() }
      else if (idle >= seconds - 10) setLeft(Math.ceil(seconds - idle))
    }, 500)
    return () => { events.forEach(name => window.removeEventListener(name, touch, { capture: true })); window.clearInterval(timer) }
  }, [seconds])
  useEffect(() => { if (paused) { dirty.current = false; setLeft(null) } }, [paused])
  return left === null ? null : <div className="cw-idle" role="alertdialog" aria-label="即将回到首页">
    <div><strong>还在看吗？</strong><span>{left} 秒后回到首页，刚才的作品会被清除</span><button className="cw-primary">继续看</button></div>
  </div>
}

/** Full-screen loop shown while the kiosk waits for the next visitor. */
function Attract({ themes, onStart }: { themes: Theme[]; onStart: () => void }) {
  const covers = themes.filter(t => t.cover_url)
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (covers.length < 2) return
    const timer = window.setInterval(() => setIndex(i => (i + 1) % covers.length), 6000)
    return () => window.clearInterval(timer)
  }, [covers.length])
  const current = covers[index % Math.max(covers.length, 1)]
  return <button className="cw-attract" onClick={onStart} aria-label="开始浏览">
    {covers.map((t, i) => <img key={t.id} src={t.cover_url!} alt="" className={i === index % covers.length ? 'on' : ''} />)}
    <span className="cw-attract-text">
      <small>武氏墓群石刻 · 电子文创</small>
      <strong>把一个汉画故事带回家</strong>
      {current && <em>{current.title} · {current.hook}</em>}
      <b>轻触屏幕，开始</b>
    </span>
  </button>
}
