import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { selectIs2d, selectIs3d, useApp } from '../store/useApp'
import AlignView from './AlignView'
import AnnotationPanel from './AnnotationPanel'
import ErrorBoundary from './ErrorBoundary'
import Home from './Home'
import InfoPanel from './InfoPanel'
import StoneTree from './StoneTree'
import ToolPanel from './tools/ToolPanel'
import Viewer2D from './viewer/Viewer2D'
import Viewer3D from './viewer/Viewer3D'
import ViewerBar from './viewer/ViewerBar'

function Pane({ title, count, children }: { title: string; count?: number | string; children: React.ReactNode }) {
  return (
    <section className="pane">
      <div className="pane-h">
        {title}
        <span className="grow" />
        {count != null && <span className="count">{count}</span>}
      </div>
      <div className="pane-b">{children}</div>
    </section>
  )
}

export default function Workbench() {
  const asset = useApp(s => s.curAsset)
  const tool = useApp(s => s.tool)
  const annosCount = useApp(s => s.annos.length)
  const is2d = useApp(selectIs2d)
  const is3d = useApp(selectIs3d)

  const outer = useDefaultLayout({ id: 'stonelab.layout.outer', storage: localStorage })
  const left = useDefaultLayout({ id: 'stonelab.layout.left', storage: localStorage })
  const right = useDefaultLayout({ id: 'stonelab.layout.right', storage: localStorage })

  const showAlign = tool === 'align' && asset != null && is2d

  return (
    <div className="body">
      <Group orientation="horizontal" id="outer" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="left" defaultSize="21%" minSize="240px" maxSize="40%">
          <aside className="side">
            <Group orientation="vertical" id="left-v" defaultLayout={left.defaultLayout} onLayoutChanged={left.onLayoutChanged}>
              <Panel id="tree" defaultSize="52%" minSize="20%">
                <Pane title="画像石"><ErrorBoundary area="画像石列表"><StoneTree /></ErrorBoundary></Pane>
              </Panel>
              <Separator className="sep-v" />
              <Panel id="tools" minSize="20%">
                <Pane title="工具"><ErrorBoundary area="工具面板"><ToolPanel /></ErrorBoundary></Pane>
              </Panel>
            </Group>
          </aside>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="center" minSize="30%">
          <main className="center">
            <ViewerBar />
            <ErrorBoundary area="查看器" resetKey={`${asset?.id ?? 0}:${showAlign ? 'align' : 'view'}`}>
              {!asset ? <Home />
                : showAlign ? <AlignView leftAsset={asset} />
                  : is3d ? <Viewer3D key={asset.id} asset={asset} />
                    : <Viewer2D asset={asset} />}
            </ErrorBoundary>
          </main>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="right" defaultSize="25%" minSize="260px" maxSize="45%">
          <aside className="side">
            <Group orientation="vertical" id="right-v" defaultLayout={right.defaultLayout} onLayoutChanged={right.onLayoutChanged}>
              <Panel id="info" defaultSize="55%" minSize="20%">
                <Pane title="简介与释文"><ErrorBoundary area="简介"><InfoPanel /></ErrorBoundary></Pane>
              </Panel>
              <Separator className="sep-v" />
              <Panel id="annos" minSize="20%">
                <Pane title="标注" count={asset ? `${annosCount} 条` : undefined}>
                  <ErrorBoundary area="标注面板"><AnnotationPanel /></ErrorBoundary>
                </Pane>
              </Panel>
            </Group>
          </aside>
        </Panel>
      </Group>
    </div>
  )
}
