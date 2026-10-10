import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react'
import { useApp } from '../store/useApp'

interface Props {
  children: ReactNode; area?: string; resetKey?: string | number
  /** 公开展示区：面向观众的措辞，不提工作台工具与控制台 */
  publicArea?: boolean
}
interface State { error: Error | null }

/** 重新构建前端后，已打开的旧页面再按需载入模块会找不到旧文件名，刷新即可恢复。 */
const STALE_CHUNK = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i

/**
 * 局部错误边界：某个面板抛错时只显示错误卡片，不让整棵树被卸载成黑屏。
 * "重置"会切回选中工具并清空错误；resetKey 变化（如切换资产）时也自动清空错误，
 * 但不会像 key 那样强制重建子树（重建会反复新建 WebGL 上下文）。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[StoneLab] ${this.props.area ?? 'ui'} crashed:`, error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  reset = () => {
    useApp.getState().setTool('select')
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const area = this.props.area ?? '界面'
    const reload = <button className="btn sm" onClick={() => location.reload()}><RefreshCw size={13} />刷新页面</button>
    if (STALE_CHUNK.test(error.message)) {
      return (
        <div className="empty" style={{ height: '100%' }} role="alert">
          <RefreshCw size={26} style={{ color: 'var(--accent)' }} />
          <b>平台已更新</b>
          <div className="hint">当前打开的是更新前的页面，{area}需要刷新后才能载入。</div>
          <button className="btn primary sm" onClick={() => location.reload()}><RefreshCw size={13} />刷新页面</button>
        </div>
      )
    }
    if (this.props.publicArea) {
      return (
        <div className="empty" style={{ height: '100%' }} role="alert">
          <AlertTriangle size={26} style={{ color: 'var(--red)' }} />
          <b>{area}暂时无法显示</b>
          <div className="hint">可以先重试；仍无法显示时，请刷新页面或联系现场工作人员。</div>
          <details className="hint" style={{ maxWidth: 560, wordBreak: 'break-word' }}><summary>技术信息</summary>{error.message}</details>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" onClick={this.reset}><RotateCcw size={13} />重试</button>
            {reload}
          </div>
        </div>
      )
    }
    return (
      <div className="empty" style={{ height: '100%' }} role="alert">
        <AlertTriangle size={26} style={{ color: 'var(--red)' }} />
        <b>{area}出错了</b>
        <div className="note-box error" style={{ maxWidth: 560, textAlign: 'left', wordBreak: 'break-word' }}>
          {error.message}
        </div>
        <div className="hint">详细堆栈见浏览器控制台（F12）。数据都在后端，未受影响。</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary sm" onClick={this.reset}>
            <RotateCcw size={13} />重置并回到「选中」工具
          </button>
          {reload}
        </div>
      </div>
    )
  }
}
