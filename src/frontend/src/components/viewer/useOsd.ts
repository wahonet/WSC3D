import { useCallback, useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import type { Pt } from '../../lib/geometry'

export interface OsdOptions {
  navigator?: boolean
  dragToPan?: boolean
  scrollToZoom?: boolean
}

/**
 * 管理一个 OpenSeadragon 查看器的生命周期，提供归一化坐标 <-> 元素像素 的换算。
 * src 为图源 URL（预览图或预处理图，尺寸一致，标注坐标不受影响）。
 * 不使用 OSD 自带控件（避免依赖外网图标资源），缩放/复位由外部按钮调用 viewer API。
 */
export function useOsd(src: string | null, opts: OsdOptions = {}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null)
  const [ready, setReady] = useState(false)
  const [, setTick] = useState(0)
  const { navigator = true, dragToPan = true, scrollToZoom = true } = opts

  useEffect(() => {
    if (!hostRef.current) return
    const v = OpenSeadragon({
      element: hostRef.current,
      showNavigator: navigator,
      navigatorPosition: 'BOTTOM_RIGHT',
      navigatorSizeRatio: 0.16,
      showNavigationControl: false,
      showFullPageControl: false,
      maxZoomPixelRatio: 8,
      minZoomLevel: 0.15,
      visibilityRatio: 0.35,
      animationTime: 0.6,
      springStiffness: 8,
      zoomPerScroll: 1.35,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: false, dragToPan, scrollToZoom },
    })
    viewerRef.current = v
    const bump = () => setTick(t => t + 1)
    // 导航器只在视口变化时重新量容器尺寸；容器被可拖拽面板改变大小后，要主动刷新，
    // 否则缩略图会按旧尺寸裁切（表现为下边缘缺失，拖一下主图才恢复）
    const refreshNavigator = () => {
      const nav = (v as unknown as { navigator?: { update: (vp: OpenSeadragon.Viewport) => void } }).navigator
      if (nav && v.viewport) nav.update(v.viewport)
    }
    v.addHandler('update-viewport', bump)
    v.addHandler('open', () => {
      setReady(true)
      bump()
      requestAnimationFrame(refreshNavigator)
      window.setTimeout(refreshNavigator, 300)
    })
    v.addHandler('open-failed', () => setReady(false))
    window.addEventListener('resize', bump)
    const ro = new ResizeObserver(() => { refreshNavigator(); bump() })
    ro.observe(hostRef.current)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', bump)
      v.destroy()
      viewerRef.current = null
    }
  }, [navigator, dragToPan, scrollToZoom])

  useEffect(() => {
    const v = viewerRef.current
    if (!v) return
    setReady(false)
    if (!src) { v.close(); return }
    v.open({ type: 'image', url: src })
  }, [src])

  /** 归一化坐标 -> 查看器元素像素 */
  const toEl = useCallback((p: Pt): Pt => {
    const v = viewerRef.current
    const item = v?.world.getItemAt(0)
    if (!v || !item) return [0, 0]
    const s = item.getContentSize()
    const q = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(p[0] * s.x, p[1] * s.y))
    return [q.x, q.y]
  }, [])

  /** 查看器元素像素 -> 归一化坐标（不裁剪） */
  const toNorm = useCallback((ex: number, ey: number): Pt => {
    const v = viewerRef.current
    const item = v?.world.getItemAt(0)
    if (!v || !item) return [0, 0]
    const s = item.getContentSize()
    const q = v.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(ex, ey))
    return [q.x / s.x, q.y / s.y]
  }, [])

  /** 事件 -> 元素内像素 */
  const eventPos = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const r = hostRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }, [])

  const zoomBy = useCallback((f: number) => {
    const v = viewerRef.current
    if (!v) return
    v.viewport.zoomBy(f)
    v.viewport.applyConstraints()
  }, [])

  const goHome = useCallback(() => viewerRef.current?.viewport.goHome(), [])

  /** 把视口移到归一化外接矩形（带留白） */
  const fitNorm = useCallback((b: [number, number, number, number]) => {
    const v = viewerRef.current
    const item = v?.world.getItemAt(0)
    if (!v || !item) return
    const s = item.getContentSize()
    const aspect = s.y / s.x
    const pad = 0.6
    const [x, y, w, h] = b
    const rect = new OpenSeadragon.Rect(x - w * pad, (y - h * pad) * aspect, w * (1 + 2 * pad), h * (1 + 2 * pad) * aspect)
    v.viewport.fitBounds(rect)
  }, [])

  return { hostRef, viewerRef, ready, toEl, toNorm, eventPos, zoomBy, goHome, fitNorm }
}
