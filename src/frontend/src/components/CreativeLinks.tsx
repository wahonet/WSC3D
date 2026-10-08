import { useEffect, useState } from 'react'
import { ArrowRight, Sparkles } from 'lucide-react'
import { goToSection } from '../lib/navigation'
import './CreativeLinks.css'

/** A published 电子文创 theme in brief; `nodes` are graph nodes linked through the theme's annotations. */
export type ThemeLink = { id: string; title: string; hook: string; stone_id: string; hall: string | null; cover_url: string | null; nodes: string[] }

let cached: Promise<ThemeLink[]> | null = null
export function listThemeLinks() {
  if (!cached) {
    cached = fetch('/api/creative/links', { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
    cached.catch(() => { cached = null })
  }
  return cached
}

export function useThemeLinks() {
  const [links, setLinks] = useState<ThemeLink[]>([])
  useEffect(() => {
    let live = true
    listThemeLinks().then(value => { if (live) setLinks(value) }).catch(() => undefined)
    return () => { live = false }
  }, [])
  return links
}

export function openTheme(id: string, product?: string) {
  goToSection('creative', { theme: id, product: product || null })
}

/** Entry from other modules into the visitor theme pages; renders nothing when no theme matches. */
export default function CreativeLinks({ match, title = '电子文创', hint, product, className = '' }: {
  match: (theme: ThemeLink) => boolean; title?: string; hint?: string; product?: string; className?: string
}) {
  const themes = useThemeLinks().filter(match)
  if (!themes.length) return null
  return <section className={'creative-links ' + className} aria-label={title}>
    <header><Sparkles size={14} /><span>{title}</span>{hint && <small>{hint}</small>}</header>
    {themes.map(t => <button key={t.id} onClick={() => openTheme(t.id, product)}>
      {t.cover_url ? <img src={t.cover_url} alt="" loading="lazy" /> : <i />}
      <span><strong>{t.title}</strong>{t.hook && <em>{t.hook}</em>}</span>
      <ArrowRight size={15} />
    </button>)}
  </section>
}
