import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { isStructural } from '../lib/tree'
import { useApp } from '../store/useApp'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import NodeDetail from '../components/structure/NodeDetail'
import StructurePanel from '../components/structure/StructurePanel'
import { Pane } from '../components/ui'

/** 模块三 · 标注：左侧结构树（全部实体），中央图像，右侧标注表单 */
export default function AnnotatePage() {
  const nodeCount = useApp(s => s.stoneAnnos.filter(isStructural).length)
  const selectedId = useApp(s => s.selectedId)
  const outer = useDefaultLayout({ id: 'stonelab.layout.annotate', storage: localStorage })

  return (
    <div className="body">
      <Group orientation="horizontal" id="annotate" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="left" className="panel-clip" defaultSize="24%" minSize="260px" maxSize="40%">
          <aside className="side">
            <Pane title="结构树" count={`${nodeCount} 节点`}>
              <ErrorBoundary area="结构树"><StructurePanel /></ErrorBoundary>
            </Pane>
          </aside>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="center" className="panel-clip" minSize="30%">
          <CenterView mode="2d" />
        </Panel>
        <Separator className="sep-h" />
        <Panel id="right" className="panel-clip" defaultSize="28%" minSize="320px" maxSize="46%">
          <aside className="side">
            <Pane title="标注" count={selectedId != null ? `#${selectedId}` : undefined}>
              <ErrorBoundary area="标注表单" resetKey={selectedId ?? 0}><NodeDetail /></ErrorBoundary>
            </Pane>
          </aside>
        </Panel>
      </Group>
    </div>
  )
}
