import { useEffect, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { previewUrl } from '../../api'
import { COLORS } from '../../lib/constants'
import { annotationBounds, type Pt } from '../../lib/geometry'
import { clamp01 } from '../../lib/format'
import { useApp } from '../../store/useApp'
import type { AssetBrief } from '../../types'
import { Spinner } from '../ui'
import { AnnoShape, ProjectedShape, SegCandidate, SegPointMark, measureLabel } from './AnnotationShapes'
import { useOsd } from './useOsd'

interface Draft {
  kind: 'rect' | 'polygon' | 'line' | null
  start?: Pt
  cur?: Pt
  pts: Pt[]
}
const EMPTY: Draft = { kind: null, pts: [] }

export default function Viewer2D({ asset }: { asset: AssetBrief }) {
  const tool = useApp(s => s.tool)
  const shape = useApp(s => s.shape)
  const annos = useApp(s => s.annos)
  const selectedId = useApp(s => s.selectedId)
  const overlay = useApp(s => s.overlay)
  const showAnnoLayer = useApp(s => s.showAnnoLayer)
  const showSegLayer = useApp(s => s.showSegLayer)
  const projOn = useApp(s => s.projOn)
  const projItems = useApp(s => s.projItems)
  const seg = useApp(s => s.seg)
  const flyTo = useApp(s => s.flyTo)
  const viewerCmd = useApp(s => s.viewerCmd)
  const select = useApp(s => s.select)
  const createShape = useApp(s => s.createShape)
  const addSegPoint = useApp(s => s.addSegPoint)

  const interactive = tool !== 'annotate' && tool !== 'measure' && tool !== 'segment'
  const { hostRef, viewerRef, ready, toEl, toNorm, eventPos, zoomBy, goHome, fitNorm } = useOsd(asset.id)
  const overlayItemRef = useRef<OpenSeadragon.TiledImage | null>(null)
  const draftRef = useRef<Draft>(EMPTY)
  const [, forceDraft] = useState(0)
  const [cursor, setCursor] = useState<Pt | null>(null)

  const toolRef = useRef(tool); toolRef.current = tool
  const shapeRef = useRef(shape); shapeRef.current = shape
  const assetRef = useRef(asset); assetRef.current = asset

  useEffect(() => {
    viewerRef.current?.setMouseNavEnabled(interactive)
    draftRef.current = EMPTY
    forceDraft(x => x + 1)
  }, [tool, shape, interactive, viewerRef])

  useEffect(() => { overlayItemRef.current = null; draftRef.current = EMPTY }, [asset.id])

  /* ---------------- 对齐叠加层（带相似变换参数） ---------------- */
  useEffect(() => {
    const v = viewerRef.current
    if (!v || !ready) return
    if (overlayItemRef.current) {
      try { v.world.removeItem(overlayItemRef.current) } catch { /* 已移除 */ }
      overlayItemRef.current = null
    }
    if (!overlay) return
    v.addTiledImage({
      tileSource: { type: 'image', url: previewUrl(overlay.assetId) },
      opacity: overlay.opacity,
      success: (e: unknown) => {
        const item = (e as { item: OpenSeadragon.TiledImage }).item
        overlayItemRef.current = item
        const t = overlay.transform
        if (t) {
          item.setPosition(new OpenSeadragon.Point(t.xVp, t.yVp), true)
          item.setWidth(t.wVp, true)
          const anyItem = item as unknown as { setRotation?: (d: number, im?: boolean) => void }
          anyItem.setRotation?.(t.deg, true)
        }
        forceDraft(x => x + 1)
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay?.assetId, overlay?.transform, ready])

  useEffect(() => {
    if (overlay) overlayItemRef.current?.setOpacity(overlay.opacity)
  }, [overlay, overlay?.opacity])

  /* ---------------- 定位到标注 / 外部命令 ---------------- */
  useEffect(() => {
    if (!flyTo || !ready) return
    const a = annos.find(x => x.id === flyTo.id)
    const b = a && annotationBounds(a)
    if (b) fitNorm(b)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyTo?.nonce, ready])

  useEffect(() => {
    if (!viewerCmd || !ready) return
    if (viewerCmd.cmd === 'zoomIn') zoomBy(1.5)
    else if (viewerCmd.cmd === 'zoomOut') zoomBy(1 / 1.5)
    else goHome()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerCmd?.nonce])

  /* ---------------- 绘制交互 ---------------- */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const pxLen = (a: Pt, b: Pt) =>
      Math.hypot((b[0] - a[0]) * assetRef.current.width, (b[1] - a[1]) * assetRef.current.height)
    const norm = (e: PointerEvent): Pt => {
      const [x, y] = toNorm(...eventPos(e))
      return [clamp01(x), clamp01(y)]
    }

    const down = (e: PointerEvent) => {
      const t = toolRef.current
      if (e.button !== 0 || !viewerRef.current?.world.getItemAt(0)) return
      if (t === 'segment') { addSegPoint(norm(e), e.altKey ? 0 : 1); return }
      if (t !== 'annotate' && t !== 'measure') return
      const p = norm(e)
      const d = draftRef.current
      if (t === 'annotate' && shapeRef.current === 'rect') {
        draftRef.current = { kind: 'rect', start: p, cur: p, pts: [] }
      } else if (t === 'annotate' && shapeRef.current === 'polygon') {
        if (d.kind !== 'polygon') draftRef.current = { kind: 'polygon', pts: [p] }
        else d.pts.push(p)
      } else if (t === 'annotate' && shapeRef.current === 'point') {
        createShape({ atype: 'point', geometry: { p } })
      } else if (t === 'measure') {
        if (d.kind !== 'line') draftRef.current = { kind: 'line', start: p, cur: p, pts: [] }
        else if (d.start) {
          createShape({ atype: 'line', geometry: { p1: d.start, p2: p }, value: pxLen(d.start, p), unit: 'px' })
          draftRef.current = EMPTY
        }
      }
      forceDraft(x => x + 1)
    }
    const move = (e: PointerEvent) => {
      const [nx, ny] = toNorm(...eventPos(e))
      setCursor(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 ? [nx, ny] : null)
      const d = draftRef.current
      if (!d.kind) return
      d.cur = [clamp01(nx), clamp01(ny)]
      forceDraft(x => x + 1)
    }
    const up = () => {
      const d = draftRef.current
      if (d.kind === 'rect' && d.start && d.cur) {
        const x = Math.min(d.start[0], d.cur[0]), y = Math.min(d.start[1], d.cur[1])
        const w = Math.abs(d.cur[0] - d.start[0]), h = Math.abs(d.cur[1] - d.start[1])
        if (w > 0.002 && h > 0.002) createShape({ atype: 'rect', geometry: { x, y, w, h } })
        draftRef.current = EMPTY
        forceDraft(x2 => x2 + 1)
      }
    }
    const dbl = () => {
      const d = draftRef.current
      if (d.kind !== 'polygon') return
      const pts = d.pts.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 0.003)
      if (pts.length >= 3) createShape({ atype: 'polygon', geometry: { points: pts } })
      draftRef.current = EMPTY
      forceDraft(x => x + 1)
    }
    const leave = () => setCursor(null)
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && draftRef.current.kind) {
        draftRef.current = EMPTY
        forceDraft(x => x + 1)
      }
    }
    host.addEventListener('pointerdown', down)
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerup', up)
    host.addEventListener('pointerleave', leave)
    host.addEventListener('dblclick', dbl)
    window.addEventListener('keydown', key)
    return () => {
      host.removeEventListener('pointerdown', down)
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerup', up)
      host.removeEventListener('pointerleave', leave)
      host.removeEventListener('dblclick', dbl)
      window.removeEventListener('keydown', key)
    }
  }, [hostRef, viewerRef, toNorm, eventPos, createShape, addSegPoint])

  /* ---------------- 渲染 ---------------- */
  const d = draftRef.current
  const A = COLORS.amber
  const pxLenNow = (a: Pt, b: Pt) => Math.hypot((b[0] - a[0]) * asset.width, (b[1] - a[1]) * asset.height)

  return (
    <div className={`viewport tool-${tool}`}>
      <div className="osd-host" ref={hostRef} />
      {!ready && (
        <div className="loading-mask">
          <Spinner />
          {asset.has_preview ? '载入预览…' : '首次打开：正在生成预览（大 TIF 需数秒）…'}
        </div>
      )}
      <svg className="svg-overlay">
        {ready && projOn && projItems.map(p => <ProjectedShape key={`pj${p.id}`} p={p} toEl={toEl} />)}
        {ready && showAnnoLayer && annos.map(a => {
          if (a.tool === 'segment' && !showSegLayer) return null
          return <AnnoShape key={a.id} a={a} toEl={toEl} selected={a.id === selectedId}
            interactive={interactive} onSelect={select} />
        })}
        {ready && seg.dets.map((det, i) => <SegCandidate key={`sc${i}`} poly={det.polygon} toEl={toEl} />)}
        {ready && seg.points.map((sp, i) => <SegPointMark key={`sp${i}`} p={sp.p} positive={sp.label === 1} toEl={toEl} />)}

        {ready && d.kind === 'rect' && d.start && d.cur && (() => {
          const [x1, y1] = toEl(d.start), [x2, y2] = toEl(d.cur)
          return <rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)}
            fill={A} fillOpacity={0.1} stroke={A} strokeWidth={1.5} strokeDasharray="5 4" />
        })()}
        {ready && d.kind === 'polygon' && d.pts.length > 0 && (() => {
          const pts = [...d.pts, ...(d.cur ? [d.cur] : [])]
          return (
            <>
              <polyline points={pts.map(p => toEl(p).join(',')).join(' ')} fill="none" stroke={A} strokeWidth={1.5} strokeDasharray="5 4" />
              {d.pts.map((p, i) => { const [x, y] = toEl(p); return <circle key={i} cx={x} cy={y} r={3} fill={A} /> })}
            </>
          )
        })()}
        {ready && d.kind === 'line' && d.start && d.cur && (() => {
          const [x1, y1] = toEl(d.start), [x2, y2] = toEl(d.cur)
          return (
            <g>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={A} strokeWidth={2} strokeDasharray="6 4" />
              {measureLabel((x1 + x2) / 2, (y1 + y2) / 2 - 9, `${pxLenNow(d.start, d.cur).toFixed(0)} px`)}
            </g>
          )
        })()}
      </svg>

      {ready && cursor && (
        <div className="vp-float bl" style={{ pointerEvents: 'none' }}>
          <span className="coords">{Math.round(cursor[0] * asset.width)}, {Math.round(cursor[1] * asset.height)} px</span>
          {d.kind === 'polygon' && <span className="muted">双击闭合 · Esc 取消</span>}
          {d.kind === 'line' && <span className="muted">再点一处结束测量</span>}
        </div>
      )}
    </div>
  )
}
