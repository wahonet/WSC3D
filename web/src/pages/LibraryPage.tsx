import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { isStructural } from '../lib/tree'
import { useApp } from '../store/useApp'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import InfoPanel from '../components/InfoPanel'
import StructurePanel from '../components/structure/StructurePanel'
import { Pane } from '../components/ui'

/** 模块四 · 文献：左侧结构树，中央图像，右侧石头信息与释文（拖选文字关联到选中节点） */
export default function LibraryPage() {
  const nodeCount = useApp(s => s.stoneAnnos.filter(isStructural).length)
  const linked = useApp(s => s.stoneAnnos.filter(a => a.desc_text).length)
  const outer = useDefaultLayout({ id: 'stonelab.layout.library', storage: localStorage })

  return (
    <div className="body">
      <Group orientation="horizontal" id="library" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="left" className="panel-clip" defaultSize="22%" minSize="250px" maxSize="40%">
          <aside className="side">
            <Pane title="结构树" count={`${linked} / ${nodeCount} 已关联`}>
              <ErrorBoundary area="结构树"><StructurePanel /></ErrorBoundary>
            </Pane>
          </aside>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="center" className="panel-clip" minSize="30%">
          <CenterView mode="2d" />
        </Panel>
        <Separator className="sep-h" />
        <Panel id="right" className="panel-clip" defaultSize="32%" minSize="340px" maxSize="50%">
          <aside className="side">
            <Pane title="文献与释文">
              <ErrorBoundary area="文献"><InfoPanel /></ErrorBoundary>
            </Pane>
          </aside>
        </Panel>
      </Group>
    </div>
  )
}
