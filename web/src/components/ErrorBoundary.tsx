import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useApp } from '../store/useApp'

interface Props { children: ReactNode; area?: string }
interface State { error: Error | null }

/**
 * 局部错误边界：某个面板抛错时只显示错误卡片，不让整棵树被卸载成黑屏。
 * "重置"会切回选中工具并清空错误，多数渲染期错误由此恢复。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[StoneLab] ${this.props.area ?? 'ui'} crashed:`, error, info.componentStack)
  }

  reset = () => {
    useApp.getState().setTool('select')
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty" style={{ height: '100%' }}>
        <AlertTriangle size={26} style={{ color: 'var(--red)' }} />
        <b>{this.props.area ?? '界面'}出错了</b>
        <div className="note-box error" style={{ maxWidth: 560, textAlign: 'left', wordBreak: 'break-word' }}>
          {this.state.error.message}
        </div>
        <div className="hint">详细堆栈见浏览器控制台（F12）。数据都在后端，未受影响。</div>
        <button className="btn primary sm" onClick={this.reset}>
          <RotateCcw size={13} />重置并回到「选中」工具
        </button>
      </div>
    )
  }
}
