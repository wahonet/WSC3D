import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { useEffect, useState } from 'react'
import { useApp } from '../store/useApp'
import type { StoneCandidates } from '../lib/knowledgeCandidates'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import NodeDetail from '../components/structure/NodeDetail'
import StructurePanel from '../components/structure/StructurePanel'
import CandidateMenu from '../components/knowledge/CandidateMenu'
import StoneReading from '../components/knowledge/StoneReading'
import InfoPanel from '../components/InfoPanel'
import { goToSection } from '../lib/navigation'
import { Pane } from '../components/ui'

export function EvidencePage() { return <AnnotatePage evidence /> }

export default function AnnotatePage({ evidence = false }: { evidence?: boolean }) {
  const stones = useApp(s => s.stones)
  const stone = useApp(s => s.curStone)
  const selectedId = useApp(s => s.selectedId)
  const [data, setData] = useState<StoneCandidates | null>(null)
  const [topic, setTopic] = useState<string | null>(null)
  const [description, setDescription] = useState(() => new URLSearchParams(location.hash.slice(1)).get('lib') === 'link')
  const requestedStory = new URLSearchParams(location.hash.slice(1)).get('candidate_story')
  const outer = useDefaultLayout({ id: 'stonelab.layout.workbench', storage: localStorage })
  const left = useDefaultLayout({ id: 'stonelab.layout.workbench.left', storage: localStorage })
  useEffect(() => { setData(null); setTopic(null) }, [stone?.id])
  useEffect(() => {
    const sync = () => setDescription(new URLSearchParams(location.hash.slice(1)).get('lib') === 'link')
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    window.addEventListener('stonelab:open-description', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
      window.removeEventListener('stonelab:open-description', sync)
    }
  }, [])
  const showReading = () => goToSection('research', { p: 'library', lib: null, src: null, off: null })
  const openStone = async (id: string) => {
    const next = stones.find(s => s.id === id)
    if (!next) return
    const assets = next.groups.flatMap(g => g.assets).filter(a => !a.kind.startsWith('model'))
    const asset = assets.find(a => a.id === next.master_asset_id) || assets[0]
    if (asset) await useApp.getState().openAsset(next, asset)
  }
  return <div className="body annotation-workbench">
    <Group orientation="horizontal" id="workbench" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
      <Panel id="left" className="panel-clip" defaultSize="26%" minSize="250px" maxSize="42%">
        <aside className="side">
          <div className="wb-stone"><select className="select sm" aria-label="当前画像石" value={stone?.id || ''} onChange={event => void openStone(event.target.value)}>{stones.map(s => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></div>
          <Group orientation="vertical" id="workbench-left" defaultLayout={left.defaultLayout} onLayoutChanged={left.onLayoutChanged}>
            <Panel id="regions" className="panel-clip" defaultSize="45%" minSize="130px"><Pane title="分割区域"><ErrorBoundary area="分割区域"><StructurePanel compact /></ErrorBoundary></Pane></Panel>
            <Separator className="sep-v" />
            <Panel id="reading" className="panel-clip" minSize="180px"><Pane title="本石文献"><ErrorBoundary area="本石文献" resetKey={stone?.id || ''}><CandidateMenu key={stone?.id || 'none'} requestedStoryId={requestedStory} onData={setData} onTopic={evidence ? value => { setTopic(value); showReading() } : undefined} /></ErrorBoundary></Pane></Panel>
          </Group>
        </aside>
      </Panel>
      <Separator className="sep-h" />
      <Panel id="center" className="panel-clip" minSize="25%">{evidence ? <div className="side">
        <Pane title={<span className="pane-tabs">
          <button className={`pane-tab${description ? '' : ' on'}`} onClick={showReading}>文献原文</button>
          <button className={`pane-tab${description ? ' on' : ''}`} onClick={() => goToSection('research', { p: 'library', lib: 'link', doc: null, pg: null, seg: null, fig: null })}>文物释文</button>
        </span>}>
          {description ? <ErrorBoundary area="文物释文" resetKey={stone?.id || ''}><InfoPanel /></ErrorBoundary> : <StoneReading data={data} focus={topic} />}
        </Pane>
      </div> : <CenterView mode="2d" />}</Panel>
      <Separator className="sep-h" />
      <Panel id="right" className="panel-clip" defaultSize="25%" minSize="280px" maxSize="42%"><aside className="side"><Pane title="标注" count={selectedId != null ? `#${selectedId}` : undefined}><ErrorBoundary area="标注" resetKey={selectedId || 0}><NodeDetail /></ErrorBoundary></Pane></aside></Panel>
    </Group>
  </div>
}
