import { useEffect, useState, type ReactNode } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { creativeApi, type Handoff, type ProductFile, type ProductId, type Venue } from '../../lib/creativeApi'
import { goToSection } from '../../lib/navigation'
import { useEscape } from '../../hooks/useEscape'

const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
export const device = {
  ios: /iPhone|iPad|iPod/.test(agent) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  android: /Android/.test(agent),
  wechat: /MicroMessenger/i.test(agent),
}

/** Saving differs by phone system; the page says exactly which gesture works. */
export function saveHint(kind: 'image' | 'video') {
  if (device.wechat) return kind === 'image' ? '长按图片，选择「保存图片」' : '点右上角「…」，选择「在浏览器打开」后再保存'
  if (device.ios) return kind === 'image' ? '长按图片，选择「存储到“照片”」' : '点「保存视频」，在打开的页面点分享按钮，选择「存储视频」'
  if (device.android) return kind === 'image' ? '点「保存」，或长按图片选择「保存图片」' : '点「保存视频」下载，在相册或「文件」里查看'
  return kind === 'image' ? '点「保存」下载图片' : '点「保存视频」下载'
}

export const withDownload = (url: string) => url + (url.includes('?') ? '&' : '?') + 'download=1'

export type CreativeParams = { theme: string; product: string; take: string; stamp: string; code: string; stamps: boolean; mine: boolean; kiosk: boolean; screen: boolean }
export function readParams(): CreativeParams {
  const q = new URLSearchParams(location.hash.slice(1))
  return { theme: q.get('theme') || '', product: q.get('product') || '', take: q.get('take') || '', stamp: q.get('stamp') || '', code: q.get('code') || '',
    stamps: q.get('stamps') === '1', mine: q.get('mine') === '1', kiosk: q.get('kiosk') === '1', screen: q.get('screen') === '1' }
}
const cleared = { theme: null, product: null, take: null, stamp: null, code: null, stamps: null, mine: null }
/** Every visitor view is a hash address, so the browser back button and QR links land on the same screen. */
export function go(params: Partial<Record<keyof typeof cleared, string | null>> = {}) {
  goToSection('creative', { ...cleared, ...params })
}
/** Same as go() without a history entry, for addresses that must not be revisited (a claimed stamp code). */
export function replace(params: Partial<Record<keyof typeof cleared, string | null>> = {}) {
  const q = new URLSearchParams(location.hash.slice(1))
  q.set('section', 'creative')
  for (const [key, value] of Object.entries({ ...cleared, ...params })) { if (value) q.set(key, value); else q.delete(key) }
  history.replaceState(null, '', '#' + q.toString())
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function Media({ file, alt, poster, className }: { file: ProductFile; alt: string; poster?: string; className?: string }) {
  return file.kind === 'video'
    ? <video className={className} src={file.url} poster={poster} controls playsInline loop muted autoPlay />
    : <img className={className} src={file.url} alt={alt} />
}

export function Dialog({ label, onClose, children, className = '' }: { label: string; onClose: () => void; children: ReactNode; className?: string }) {
  useEscape(onClose, true)
  return <div className="cw-backdrop" onClick={onClose}><section className={'cw-dialog ' + className} role="dialog" aria-modal="true" aria-label={label} onClick={event => event.stopPropagation()}>
    <header><h2>{label}</h2><button className="cw-icon" aria-label="关闭" autoFocus onClick={onClose}><X size={22} /></button></header>{children}
  </section></div>
}

/** Take-away code shown on the kiosk; a phone on the venue Wi-Fi opens it and saves the file. */
export function HandoffDialog({ target, venue, onClose }: { target: { work_id?: string; theme?: string; product?: ProductId }; venue: Venue | null; onClose: () => void }) {
  const [value, setValue] = useState<Handoff | null>(null), [error, setError] = useState('')
  useEffect(() => { creativeApi.handoff(target).then(setValue).catch(reason => setError(reason.message)) }, [])
  return <Dialog label="用手机扫码带走" onClose={onClose} className="cw-handoff">
    <div className="cw-handoff-body">
      <div className="cw-handoff-qr">{value ? <img src={value.qr} alt="取件二维码" /> : <div className="cw-empty">{error || <><LoaderCircle className="cw-spin" size={26} />正在生成取件码</>}</div>}</div>
      <ol className="cw-handoff-steps">
        <li><b>1</b><div><strong>手机连接场馆 Wi-Fi</strong><span>{venue?.wifi_ssid ? `名称：${venue.wifi_ssid}` : '请连接场馆提供的访客 Wi-Fi'}</span>{venue?.wifi_qr && <img src={venue.wifi_qr} alt="连接场馆 Wi-Fi 的二维码" />}</div></li>
        <li><b>2</b><div><strong>用相机扫描左侧二维码</strong><span>打开页面后，把作品保存到相册</span></div></li>
      </ol>
    </div>
    <p className="cw-note">取件码 24 小时内有效。离开场馆网络后页面无法打开，请在现场保存。</p>
    <button className="cw-primary cw-wide" onClick={onClose}>完成</button>
  </Dialog>
}

/** Save buttons for phones and desktops; the kiosk offers a take-away code instead. */
export function SaveActions({ files, title }: { files: ProductFile[]; title: string }) {
  const video = files.find(f => f.kind === 'video'), images = files.filter(f => f.kind === 'image')
  return <div className="cw-save">
    {video && <a className="cw-primary" href={withDownload(video.url)} download>保存视频</a>}
    {images.length === 1 && <a className={video ? 'cw-button' : 'cw-primary'} href={withDownload(images[0].url)} download>{video ? '保存封面图' : '保存到手机'}</a>}
    {images.length > 1 && <span className="cw-note">{title}共 {images.length} 张，点每一张下方的「保存」</span>}
    <p className="cw-hint">{saveHint(video ? 'video' : 'image')}</p>
  </div>
}
