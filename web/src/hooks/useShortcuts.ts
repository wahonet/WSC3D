import { useEffect } from 'react'
import { useApp } from '../store/useApp'
import { toast } from '../store/useToast'

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

/** 工作台快捷键：V/A/M/S/L 切工具，1/2/3 切形状，F 适应窗口，Esc 回到选中，Delete 两次删除选中标注 */
export function useShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    let pendingDelete: { id: number; until: number } | null = null

    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return
      const s = useApp.getState()
      const asset = s.curAsset
      const is2d = asset != null && !asset.kind.startsWith('model')
      const k = e.key.toLowerCase()

      if (k === 'escape' || k === 'v') { s.setTool('select'); return }
      if (!asset) return
      if (k === 'a') { s.setTool('annotate'); return }
      if (k === 'm') { s.setTool('measure'); return }
      if (k === 's' && is2d) { s.setTool('segment'); return }
      if (k === 'l' && is2d) { s.setTool('align'); return }
      if (k === 'f') { s.sendViewerCmd('fit'); return }
      if (is2d && s.tool === 'annotate') {
        if (k === '1') { s.setShape('rect'); return }
        if (k === '2') { s.setShape('polygon'); return }
        if (k === '3') { s.setShape('point'); return }
      }
      if ((k === 'delete' || k === 'backspace') && s.selectedId != null) {
        e.preventDefault()
        const id = s.selectedId
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
