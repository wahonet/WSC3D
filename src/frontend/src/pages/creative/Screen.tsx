import { useEffect, useMemo, useState } from 'react'
import { creativeApi, type Theme, type Venue } from '../../lib/creativeApi'
import './screen.css'

/** One picture of a story: the rubbing it rests on, the line drawing taken from it, then the AI colouring. */
type Slide = { key: string; src: string; label: string; note: string; seconds: number }

function slides(theme: Theme): Slide[] {
  const list: Slide[] = []
  const { original, line, colors } = theme.art
  if (original) list.push({ key: 'original', src: original, label: '原石拓片', note: '故事出自这块原石', seconds: 6 })
  if (line && theme.line_kind === 'line') list.push({ key: 'line', src: line, label: '线描', note: '据拓片逐项核对整理', seconds: 6 })
  if (colors[0]) list.push({ key: 'color', src: colors[0], label: '艺术演绎', note: 'AI 辅助上色，不代表原貌', seconds: 9 })
  if (!list.length && theme.cover_url) list.push({ key: 'cover', src: theme.cover_url, label: '主题', note: '', seconds: 9 })
  return list
}

const RELOAD_AFTER = 6 * 3600 * 1000

/**
 * Display-only loop for a venue screen (`#section=creative&screen=1`): nobody touches it, so every story
 * ends in a QR code that opens the theme page on the visitor's phone. It never counts views.
 */
export default function ScreenLoop() {
  const [themes, setThemes] = useState<Theme[] | null>(null), [venue, setVenue] = useState<Venue | null>(null)
  const [cursor, setCursor] = useState({ theme: 0, slide: 0, round: 0 })
  const started = useMemo(() => Date.now(), [])

  useEffect(() => {
    document.documentElement.dataset.kiosk = '1'
    const block = (event: Event) => event.preventDefault()
    window.addEventListener('contextmenu', block)
    return () => { delete document.documentElement.dataset.kiosk; window.removeEventListener('contextmenu', block) }
  }, [])
  // Newly published themes and venue changes arrive without anyone touching the screen; a dropped
  // connection keeps the last loop running and retries.
  useEffect(() => {
    let live = true, timer = 0
    const load = () => {
      Promise.all([creativeApi.themes(), creativeApi.venue()])
        .then(([list, place]) => { if (live) { setThemes(list.filter(t => slides(t).length)); setVenue(place) } timer = window.setTimeout(load, 600_000) })
        .catch(() => { timer = window.setTimeout(load, 20_000) })
    }
    load()
    return () => { live = false; window.clearTimeout(timer) }
  }, [])

  const list = themes || []
  const index = list.length ? cursor.theme % list.length : 0
  const theme = list[index]
  const parts = theme ? slides(theme) : []
  const slide = parts[Math.min(cursor.slide, parts.length - 1)]
  useEffect(() => {
    if (!slide) return
    const timer = window.setTimeout(() => setCursor(c => {
      if (c.slide + 1 < parts.length) return { ...c, slide: c.slide + 1 }
      const next = (index + 1) % list.length
      // A signage browser runs for days; reload between stories so new builds and fonts arrive.
      if (next === 0 && Date.now() - started > RELOAD_AFTER) location.reload()
      return { theme: next, slide: 0, round: c.round + 1 }
    }), slide.seconds * 1000)
    return () => window.clearTimeout(timer)
  }, [cursor, slide?.src, list.length])

  if (!theme) return <div className="cw-screen cw-screen-empty">
    <div><small>武氏墓群石刻 · 电子文创</small><strong>把一个汉画故事带回家</strong>
      {themes && venue ? <><img src={venue.home_qr} alt="电子文创二维码" /><span>手机扫码打开</span></> : <span>正在连接平台…</span>}</div>
  </div>

  // The neighbours stay mounted so pictures cross-fade between stories and the next ones are already loaded.
  const nearby = [list[(index + list.length - 1) % list.length], theme, list[(index + 1) % list.length]]
    .filter((t, i, all) => all.findIndex(o => o.id === t.id) === i)
  const total = parts.reduce((sum, s) => sum + s.seconds, 0)
  const hall = theme.hall ? `${theme.hall.name} · ` : ''
  return <div className="cw-screen" aria-live="off">
    <section className="cw-screen-stage">
      {nearby.flatMap(t => slides(t).map(s => <img key={t.id + s.key} src={s.src} alt="" className={t.id === theme.id && s.key === slide.key ? 'on' : ''} />))}
      <ol className="cw-screen-phases">{parts.map(s => <li key={s.key} className={s.key === slide.key ? 'on' : ''}>{s.label}</li>)}</ol>
      <p className={'cw-screen-note' + (slide.key === 'color' ? ' is-ai' : '')} key={theme.id + slide.key}>{slide.note}</p>
    </section>
    <section className="cw-screen-info" key={theme.id + cursor.round}>
      <p className="cw-screen-eyebrow">{hall}{theme.stone_id} {theme.stone_name}</p>
      <h1 style={theme.title.length > 6 ? { fontSize: '6vmin' } : undefined}>{theme.title}</h1>
      {theme.hook && <p className="cw-screen-hook">{theme.hook}</p>}
      <p className="cw-screen-story">{theme.story}</p>
      <div className="cw-screen-take">
        {venue?.wifi_qr && <figure><img src={venue.wifi_qr} alt="场馆 Wi-Fi 二维码" /><figcaption><b>①</b>连场馆 Wi-Fi<small>{venue.wifi_ssid}</small></figcaption></figure>}
        <figure className="is-main"><img src={`/api/creative/themes/${theme.id}/qr`} alt={`${theme.title}二维码`} />
          <figcaption>{venue?.wifi_qr && <b>②</b>}手机扫码，把它带回家<small>壁纸 · 明信片 · 表情包，每件都印着原石出处</small></figcaption></figure>
      </div>
    </section>
    <ol className="cw-screen-dots">{list.map((t, i) => <li key={t.id} className={i === index ? 'on' : ''}>
      <span>{t.title}</span>{i === index && <i key={cursor.round} style={{ animationDuration: total + 's' }} />}</li>)}</ol>
  </div>
}
