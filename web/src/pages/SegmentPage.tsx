import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { isStructural } from '../lib/tree'
import { useApp } from '../store/useApp'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import ShapeList from '../components/ShapeList'
import StoneTree from '../components/StoneTree'
import ShapeTools from '../components/tools/ShapeTools'
import { Pane } from '../components/ui'

/** 模块二 · 分割：左上选图，左下形状 / SAM 工具；中央绘制；右侧本图实体列表 */
export default function SegmentPage() {
  const shapeCount = useApp(s => s.annos.filter(a => isStructural(a) && a.atype !== 'none').length)
  const asset = useApp(s => s.curAsset)
  const outer = useDefaultLayout({ id: 'stonelab.layout.segment', storage: localStorage })
  const left = useDefaultLayout({ id: 'stonelab.layout.segment-left', storage: localStorage })

  return (
    <div className="body">
      <Group orientation="horizontal" id="segment" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="left" className="panel-clip" defaultSize="22%" minSize="250px" maxSize="40%">
          <aside className="side">
            <Group orientation="vertical" id="segment-left" defaultLayout={left.defaultLayout} onLayoutChanged={left.onLayoutChanged}>
              <Panel id="stones" className="panel-clip" defaultSize="38%" minSize="15%">
                <Pane title="画像石"><ErrorBoundary area="画像石列表"><StoneTree /></ErrorBoundary></Pane>
              </Panel>
              <Separator className="sep-v" />
              <Panel id="tools" className="panel-clip" minSize="25%">
                <Pane title="分割工具"><ErrorBoundary area="分割工具"><ShapeTools /></ErrorBoundary></Pane>
              </Panel>
            </Group>
          </aside>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="center" className="panel-clip" minSize="35%">
          <CenterView mode="2d" />
        </Panel>
        <Separator className="sep-h" />
        <Panel id="right" className="panel-clip" defaultSize="22%" minSize="240px" maxSize="40%">
          <aside className="side">
            <Pane title="本图实体" count={asset ? `${shapeCount} 个` : undefined}>
              <ErrorBoundary area="实体列表"><ShapeList /></ErrorBoundary>
            </Pane>
          </aside>
        </Panel>
      </Group>
    </div>
  )
}
