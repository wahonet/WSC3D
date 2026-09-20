import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { useApp } from '../store/useApp'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import LayerPanel from '../components/LayerPanel'
import MeasureTools from '../components/MeasureTools'
import StoneTree from '../components/StoneTree'
import NodeInfoCard from '../components/viewer/NodeInfoCard'
import { Pane } from '../components/ui'

/** 首页：左上画像石列表，左下测量工具 + 图层；右侧只读预览（点选节点弹信息卡） */
export default function HomePage() {
  const asset = useApp(s => s.curAsset)
  const outer = useDefaultLayout({ id: 'stonelab.layout.home', storage: localStorage })
  const left = useDefaultLayout({ id: 'stonelab.layout.home-left', storage: localStorage })

  return (
    <div className="body">
      <Group orientation="horizontal" id="home" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="left" className="panel-clip" defaultSize="24%" minSize="260px" maxSize="42%">
          <aside className="side">
            <Group orientation="vertical" id="home-left" defaultLayout={left.defaultLayout} onLayoutChanged={left.onLayoutChanged}>
              <Panel id="stones" className="panel-clip" defaultSize="50%" minSize="20%">
                <Pane title="画像石"><ErrorBoundary area="画像石列表"><StoneTree /></ErrorBoundary></Pane>
              </Panel>
              <Separator className="sep-v" />
              <Panel id="layers" className="panel-clip" minSize="20%">
                <Pane title="测量与图层">
                  <ErrorBoundary area="测量工具"><MeasureTools /></ErrorBoundary>
                  <ErrorBoundary area="图层"><LayerPanel /></ErrorBoundary>
                </Pane>
              </Panel>
            </Group>
          </aside>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="center" className="panel-clip" minSize="40%">
          <CenterView mode="home">{asset && <NodeInfoCard />}</CenterView>
        </Panel>
      </Group>
    </div>
  )
}
