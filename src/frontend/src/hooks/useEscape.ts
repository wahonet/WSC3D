import { useEffect, useRef } from 'react'

/** 弹窗的 Esc 关闭：捕获阶段处理并停止传播，同一次按键不再触发全局快捷键（取消选中、退出工具）。 */
export function useEscape(onEscape: () => void, enabled = true) {
  const ref = useRef(onEscape)
  ref.current = onEscape
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      ref.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}
