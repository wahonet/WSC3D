import type { ReactNode } from 'react'
import { Box } from 'lucide-react'
import { selectIs3d, useApp } from '../store/useApp'
import AlignView from './AlignView'
import ErrorBoundary from './ErrorBoundary'
import Home from './Home'
import { Button, Empty } from './ui'
import Viewer2D from './viewer/Viewer2D'
import Viewer3D from './viewer/Viewer3D'
import ViewerBar from './viewer/ViewerBar'

/**
 * 中央区：查看器顶栏 + 内容。
 * 未打开素材 -> 首页仪表；三维 -> 仅首页可看；对齐模块 -> 分屏配准；其余 -> 2D 查看器。
 */
export default function CenterView({ mode, children }: { mode: 'home' | 'align' | '2d'; children?: ReactNode }) {
  const asset = useApp(s => s.curAsset)
  const stone = useApp(s => s.curStone)
  const is3d = useApp(selectIs3d)
  const setPage = useApp(s => s.setPage)

  let body: ReactNode
  if (!asset) {
    body = mode === 'home' ? <Home /> : (
      <Empty title={stone ? '在左侧或顶栏切图处打开一张照片 / 拓片' : '先选择一块画像石'}>
        {!stone && <Button size="sm" onClick={() => setPage('home')}>去首页选择</Button>}
      </Empty>
    )
  } else if (is3d) {
    body = mode === 'home' ? <Viewer3D key={asset.id} asset={asset} /> : (
      <Empty icon={<Box size={22} />} title="此模块只处理照片 / 拓片">三维模型请在首页查看；用顶栏的切图下拉换到一张 2D 图</Empty>
    )
  } else if (mode === 'align') {
    body = <AlignView leftAsset={asset} />
  } else {
    body = <Viewer2D asset={asset} />
  }

  return (
    <main className="center">
      <ViewerBar />
      <ErrorBoundary area="查看器" resetKey={`${asset?.id ?? 0}:${mode}`}>
        <div className="center-body">
          {body}
          {children}
        </div>
      </ErrorBoundary>
    </main>
  )
}
