import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * 画廊滚动到“继续显示”按钮附近时自动加载下一批；按钮本身保留，键盘和读屏用户仍可点击。
 * 返回的回调 ref 挂到按钮上。limit 变化后重新观察：若加载后按钮仍在可视范围内（屏幕很高），会继续加载。
 */
export function useAutoMore(root: RefObject<HTMLElement | null>, limit: number, more: () => void) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const latest = useRef(more)
  latest.current = more
  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) latest.current()
    }, { root: root.current, rootMargin: '0px 0px 600px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [root, element, limit])
  return useCallback((node: HTMLElement | null) => setElement(node), [])
}
