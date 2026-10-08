import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/** Keep the clicked card at the same visible offset when the detail column reflows the grid. */
export function useGalleryScroll(host: RefObject<HTMLElement | null>, selection: number) {
  const pending = useRef<{ top: number; anchor: HTMLElement | null; offset: number } | null>(null)
  const remember = useCallback((anchor?: HTMLElement | null) => {
    const container = host.current
    if (!container) return
    const card = anchor ?? container.querySelector<HTMLElement>('.motif-card.is-selected')
    pending.current = { top: container.scrollTop, anchor: card,
      offset: card ? card.getBoundingClientRect().top - container.getBoundingClientRect().top : 0 }
  }, [host])
  useLayoutEffect(() => {
    const saved = pending.current, container = host.current
    if (!saved || !container) return
    if (saved.anchor?.isConnected && container.contains(saved.anchor)) {
      container.scrollTop += saved.anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - saved.offset
    } else container.scrollTop = saved.top
    pending.current = null
  }, [host, selection])
  return remember
}
