import { useEffect, useRef, useState } from 'react'
import { Languages } from 'lucide-react'
import { LANGS, useLang } from '../i18n/lang'

export default function LanguageMenu() {
  const lang = useLang(s => s.lang), setLang = useLang(s => s.setLang)
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => { if (!host.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key) }
  }, [open])
  return <div className="lang-menu" ref={host}>
    <button className="unified-icon" data-tip={open ? undefined : '语言'} aria-label="切换语言" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><Languages size={19} /></button>
    {open && <div className="lang-menu-list" role="menu" data-i18n-skip>
      {LANGS.map(item => <button key={item.id} role="menuitemradio" aria-checked={lang === item.id} lang={item.html} className={lang === item.id ? 'on' : ''} onClick={() => { setLang(item.id); setOpen(false) }}>{item.label}</button>)}
    </div>}
  </div>
}
