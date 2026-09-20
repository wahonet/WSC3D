import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import AlignSidebar from '../components/AlignSidebar'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import StoneTree from '../components/StoneTree'
import { Pane } from '../components/ui'

/** 模块一 · 对齐：左上选左图，左下看坐标系状态与记录；中央左右分屏取同名点 */
export default function AlignPage() {
  const outer = useDefaultLayout({ id: 'stonelab.layout.align', storage: localStorage })
  const left = useDefaultLayout({ id: 'stonelab.layout.align-left', storage: localStorage })

  return (
    <div className="body">
      <Group orientation="horizontal" id="align" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="left" className="panel-clip" defaultSize="24%" minSize="260px" maxSize="42%">
          <aside className="side">
            <Group orientation="vertical" id="align-left" defaultLayout={left.defaultLayout} onLayoutChanged={left.onLayoutChanged}>
              <Panel id="stones" className="panel-clip" defaultSize="45%" minSize="20%">
                <Pane title="画像石 · 选左图"><ErrorBoundary area="画像石列表"><StoneTree /></ErrorBoundary></Pane>
              </Panel>
              <Separator className="sep-v" />
              <Panel id="status" className="panel-clip" minSize="20%">
                <Pane title="坐标系与对齐记录"><ErrorBoundary area="对齐状态"><AlignSidebar /></ErrorBoundary></Pane>
              </Panel>
            </Group>
          </aside>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="center" className="panel-clip" minSize="40%">
          <CenterView mode="align" />
        </Panel>
      </Group>
    </div>
  )
}
