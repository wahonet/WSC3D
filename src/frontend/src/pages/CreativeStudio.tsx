import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import VideoPage from './VideoPage'
import ThemeStudio from './creative/ThemeStudio'
import { ThemeList, VenuePanel } from './creative/StudioPanels'
import { creativeApi, type Venue } from '../lib/creativeApi'
import { goToSection } from '../lib/navigation'
import './creative/studio.css'

type Tab = 'themes' | 'video' | 'venue'
const TABS: [Tab, string][] = [['themes', '主题制作'], ['video', '动态短片'], ['venue', '场馆与现场']]

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1))
  const tab = q.has('video_nodes') ? 'video' : q.get('creative_tab')
  return { tab: (TABS.some(([key]) => key === tab) ? tab : 'themes') as Tab, theme: q.get('ct') || '' }
}

/** Production side of 电子文创: every theme goes through reviewed steps before visitors see it. */
export default function CreativeStudio() {
  const [{ tab, theme }, setState] = useState(readHash)
  const [venue, setVenue] = useState<Venue | null>(null)
  useEffect(() => {
    creativeApi.venue().then(setVenue).catch(() => undefined)
    const sync = () => setState(readHash())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  const open = (next: Tab, id: string | null = null) => goToSection('video', { creative_tab: next === 'themes' ? null : next, ct: id, video_nodes: null })
  return <div className="cs-root">
    <div className="cs-tabs" role="tablist" aria-label="电子文创工作台">
      {TABS.map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => open(key)}>{label}</button>)}
      <span />
      <button onClick={() => goToSection('creative', { creative_tab: null, ct: null, theme: null, product: null })}>查看观众端<ArrowUpRight size={14} /></button>
    </div>
    {tab === 'video' ? <VideoPage /> : tab === 'venue' ? <VenuePanel halls={venue?.halls || []} />
      : theme ? <ThemeStudio key={theme} id={theme} venue={venue} onBack={() => open('themes')} /> : <ThemeList onOpen={id => open('themes', id)} />}
  </div>
}
