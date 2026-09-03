import { useEffect } from 'react'
import { PAGE_TOOLS } from '../lib/constants'
import { useApp } from '../store/useApp'
import { toast } from '../store/useToast'

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

/**
 * 全局快捷键（按模块门控，见 PAGE_TOOLS）：
 * V 选中 · A 绘制（1/2/3/4 矩形/圆形/多边形/点）· S SAM · M 测量 · F 适应窗口；
 * Esc 回到选中工具（已在选中工具时取消选中）；↑/↓ 结构树移动，Enter 定位，R 候选转正；Delete 两次删除。
 */
export function useShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let pendingDelete: { id: number; until: number } | null = null

    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return
      const s = useApp.getState()
      const asset = s.curAsset
      const is2d = asset != null && !asset.kind.startsWith('model')
      const allowed = PAGE_TOOLS[s.page]
      const k = e.key.toLowerCase()

      if (k === 'escape') {
        if (s.tool !== 'select') s.setTool('select')
        else if (s.selectedId != null || s.multiSel.length) s.select(null)
        return
      }
      if (k === 'v') { s.setTool('select'); return }

      // 结构树导航（标注 / 文献模块）
      if (k === 'arrowdown' || k === 'arrowup') {
        const order = s.treeOrder
        if (order.length === 0 || (s.page !== 'annotate' && s.page !== 'library')) return
        e.preventDefault()
        const i = s.selectedId != null ? order.indexOf(s.selectedId) : -1
        const j = k === 'arrowdown' ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1)
        if (order[j] != null) s.select(order[j])
        return
      }
      if (k === 'enter' && s.selectedId != null) { s.flyToAnnotation(s.selectedId); return }
      if (k === 'r' && s.selectedId != null && (s.page === 'annotate' || s.page === 'segment')) {
        const a = s.stoneAnnos.find(x => x.id === s.selectedId)
        if (a && a.review_status === 'candidate') s.updateAnnotation(a.id, { review_status: 'reviewed' }).then(() => toast.ok(`「${a.label}」已转正`))
        return
      }

      if (!asset) return
      if (k === 'f') { s.sendViewerCmd('fit'); return }
      if (k === 'a' && allowed.includes('annotate') && is2d) { s.setTool('annotate'); return }
      if (k === 'm' && allowed.includes('measure')) { s.setTool('measure'); return }
      if (k === 's' && allowed.includes('segment') && is2d) { s.setTool('segment'); return }
      if (is2d && s.tool === 'annotate') {
        if (k === '1') { s.setShape('rect'); return }
        if (k === '2') { s.setShape('ellipse'); return }
        if (k === '3') { s.setShape('polygon'); return }
        if (k === '4') { s.setShape('point'); return }
      }
      if ((k === 'delete' || k === 'backspace') && (s.selectedId != null || s.multiSel.length > 1)) {
        // 展示 / 文献模块不删结构节点（首页只允许删测量记录）
        if (s.page === 'library') return
        if (s.page === 'home' && s.annos.find(x => x.id === s.selectedId)?.tool !== 'measure') return
        e.preventDefault()
        if (s.multiSel.length > 1) {
          const key = -1
          if (pendingDelete && pendingDelete.id === key && Date.now() < pendingDelete.until) {
            pendingDelete = null
            s.removeAnnotations(s.multiSel)
          } else {
            pendingDelete = { id: key, until: Date.now() + 2500 }
            toast.warn(`再按一次 Delete 删除已多选的 ${s.multiSel.length} 个节点`)
          }
          return
        }
        const id = s.selectedId!
        if (pendingDelete && pendingDelete.id === id && Date.now() < pendingDelete.until) {
          pendingDelete = null
          s.removeAnnotation(id)
        } else {
          pendingDelete = { id, until: Date.now() + 2500 }
          toast.warn('再按一次 Delete 确认删除选中标注')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
