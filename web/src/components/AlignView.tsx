import { useEffect, useMemo, useRef, useState } from 'react'
import OpenSeadragon from 'openseadragon'
import { Check, Eraser, Undo2, X } from 'lucide-react'
import { alignCommit, previewUrl } from '../api'
import { COLORS, MAX_PAIRS, MIN_PAIRS } from '../lib/constants'
import { alignGeomToOverlay, solveSimilarity, type Pt } from '../lib/geometry'
import { useApp } from '../store/useApp'
import { toast } from '../store/useToast'
import type { AlignGeometry, AssetBrief } from '../types'
import { Badge, Button, Empty, Spinner } from './ui'
import { useOsd } from './viewer/useOsd'

interface Pair { a?: Pt; b?: Pt }

/** 单侧取点视图：左键取点，右键拖动平移，滚轮缩放 */
function Pane({ asset, color, pts, onPick, sideLabel, active, highlight }: {
  asset: AssetBrief; color: string; pts: Pt[]; onPick: (p: Pt) => void
  sideLabel: string; active: boolean; highlight: number | null
}) {
  const { hostRef, viewerRef, ready, toEl, toNorm, eventPos } = useOsd(previewUrl(asset.id), { navigator: false, dragToPan: false })
  const onPickRef = useRef(onPick); onPickRef.current = onPick

  useEffect(() => {
    const host = hostRef.current
    const v = viewerRef.current
    if (!host || !v) return
    let leftDown: Pt | null = null
    let rightDown: Pt | null = null
    const ctx = (e: MouseEvent) => e.preventDefault()
    const pd = (e: PointerEvent) => {
      if (e.button === 0) leftDown = [e.clientX, e.clientY]
      if (e.button === 2) rightDown = [e.clientX, e.clientY]
    }
    const pm = (e: PointerEvent) => {
      if (rightDown && (e.buttons & 2)) {
        const dx = e.clientX - rightDown[0], dy = e.clientY - rightDown[1]
        rightDown = [e.clientX, e.clientY]
        v.viewport.panBy(v.viewport.deltaPointsFromPixels(new OpenSeadragon.Point(-dx, -dy)), true)
        v.viewport.applyConstraints(true)
      }
    }
    const pu = (e: PointerEvent) => {
      if (e.button === 2) { rightDown = null; return }
      if (e.button !== 0 || !leftDown) return
      const moved = Math.hypot(e.clientX - leftDown[0], e.clientY - leftDown[1])
      leftDown = null
      if (moved > 8 || !v.world.getItemAt(0)) return
      const [nx, ny] = toNorm(...eventPos(e))
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return
      onPickRef.current([nx, ny])
    }
    host.addEventListener('contextmenu', ctx)
    host.addEventListener('pointerdown', pd)
    host.addEventListener('pointermove', pm)
    host.addEventListener('pointerup', pu)
    return () => {
      host.removeEventListener('contextmenu', ctx)
      host.removeEventListener('pointerdown', pd)
      host.removeEventListener('pointermove', pm)
      host.removeEventListener('pointerup', pu)
    }
  }, [hostRef, viewerRef, toNorm, eventPos, ready])

  return (
    <div className={`align-pane${active ? ' active' : ''}`} style={{ ['--pane-color' as string]: color }}>
      <div className="align-pane-label" style={{ background: color }}>
        <b>{sideLabel}</b><span>{asset.filename}</span>{asset.is_master && <Badge>主图</Badge>}
      </div>
      <div className="osd-host" ref={hostRef} />
      {!ready && <div className="loading-mask"><Spinner />载入预览…</div>}
      <svg className="svg-overlay">
        {ready && pts.map((p, i) => {
          const [x, y] = toEl(p)
          return (
            <g key={i}>
              {highlight === i && <circle cx={x} cy={y} r={15} fill="none" stroke="#ffd23e" strokeWidth={2.5} />}
              <line x1={x - 9} y1={y} x2={x + 9} y2={y} stroke={color} strokeWidth={2} />
              <line x1={x} y1={y - 9} x2={x} y2={y + 9} stroke={color} strokeWidth={2} />
              <circle cx={x} cy={y} r={5.5} fill={color} fillOpacity={0.25} stroke={color} strokeWidth={1.6} />
              <text x={x + 12} y={y - 9} fill="#fff" stroke="#14120f" strokeWidth={3} paintOrder="stroke"
                fontSize={13} fontWeight={700} fontFamily="var(--font-mono)">{i + 1}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export default function AlignView({ leftAsset }: { leftAsset: AssetBrief }) {
  const stone = useApp(s => s.curStone)!
  // 注意：zustand 选择器不能每次返回新数组（会无限重渲染），派生列表用 useMemo
  const candidates = useMemo(
    () => stone.groups.filter(g => g.key !== 'model').flatMap(g => g.assets), [stone])
  const onAligned = useApp(s => s.onAligned)
  const setTool = useApp(s => s.setTool)

  const [rightId, setRightId] = useState<number | ''>('')
  const [pairs, setPairs] = useState<Pair[]>([])
  const [saving, setSaving] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const right = candidates.find(a => a.id === rightId) || null
  const leftChained = leftAsset.is_master || leftAsset.in_frame

  const expecting: 'L' | 'R' = useMemo(() => {
    const last = pairs[pairs.length - 1]
    return last && last.a && !last.b ? 'R' : 'L'
  }, [pairs])
  const complete = useMemo(() => pairs.filter(p => p.a && p.b), [pairs])
  const solution = useMemo(() => {
    if (!right || complete.length < MIN_PAIRS) return null
    const L: Pt[] = complete.map(p => [p.a![0] * leftAsset.width, p.a![1] * leftAsset.height])
    const R: Pt[] = complete.map(p => [p.b![0] * right.width, p.b![1] * right.height])
    return solveSimilarity(L, R)
  }, [complete, right, leftAsset])

  const pickL = (p: Pt) => {
    if (expecting !== 'L' || complete.length >= MAX_PAIRS) return
    setPairs(ps => [...ps, { a: p }])
  }
  const pickR = (p: Pt) => {
    if (expecting !== 'R') return
    setPairs(ps => ps.map((x, i) => i === ps.length - 1 ? { ...x, b: p } : x))
  }
  const undo = () => setPairs(ps => {
    if (ps.length === 0) return ps
    const last = ps[ps.length - 1]
    if (last.a && last.b) return ps.map((x, i) => i === ps.length - 1 ? { a: x.a } : x)
    return ps.slice(0, -1)
  })
  const deletePair = (i: number) => { setPairs(ps => ps.filter((_, k) => k !== i)); setHover(null) }

  const confirm = async () => {
    if (!right || !solution) return
    setSaving(true)
    try {
      const geom: AlignGeometry = {
        target_asset_id: right.id,
        pairs: complete.map(p => ({ a: p.a!, b: p.b! })),
        s: solution.s, theta_deg: solution.theta_deg, tx: solution.tx, ty: solution.ty, rmse_px: solution.rmse,
        wl: leftAsset.width, hl: leftAsset.height, wr: right.width, hr: right.height,
      }
      const r = await alignCommit({
        stone_id: stone.id, left_asset_id: leftAsset.id, right_asset_id: right.id,
        geometry: geom as unknown as Record<string, unknown>,
      })
      if (r.chain_updates.length > 0) toast.ok(r.chain_updates.join('；'))
      else if (r.warning) toast.warn(r.warning)
      else toast.ok('对齐已保存')
      await onAligned(r.annotation, right.id, alignGeomToOverlay(geom))
    } catch (e) { toast.error(e) } finally { setSaving(false) }
  }

  const rmseTone = solution ? (solution.rmse < 8 ? 'green' : solution.rmse < 25 ? 'amber' : 'red') : undefined

  return (
    <div className="align-wrap">
      <div className="align-bar">
        <select className="select sm" style={{ width: 280 }} value={rightId}
          onChange={e => { setRightId(e.target.value ? Number(e.target.value) : ''); setPairs([]) }}>
          <option value="">选择右侧比对图…</option>
          {candidates.filter(a => a.id !== leftAsset.id).map(a => (
            <option key={a.id} value={a.id}>
              {a.is_master ? '[主图] ' : a.in_frame ? '[链] ' : ''}{a.kind_label} · {a.filename}
            </option>
          ))}
        </select>
        <span className="align-stat">左图
          {leftChained ? <Badge tone="green">已连主图</Badge> : <Badge tone="amber">未连主图</Badge>}
        </span>
        {right && (
          <span className="align-stat">下一点
            <b style={{ color: expecting === 'L' ? COLORS.alignL : COLORS.alignR }}>
              {expecting === 'L' ? `左 #${complete.length + 1}` : `右 #${pairs.length}`}
            </b>
          </span>
        )}
        <span className="align-stat">配对 <b>{complete.length}</b>/{MIN_PAIRS}~{MAX_PAIRS}</span>
        {solution && <span className="align-stat">RMSE <Badge tone={rmseTone} mono>{solution.rmse.toFixed(1)} px</Badge></span>}
        <span className="muted">左键取点 · 右键拖图 · 滚轮缩放</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" icon={<Undo2 size={13} />} onClick={undo} disabled={pairs.length === 0}>撤销</Button>
        <Button size="sm" icon={<Eraser size={13} />} onClick={() => { setPairs([]); setHover(null) }} disabled={pairs.length === 0}>清空</Button>
        <Button size="sm" variant="primary" icon={<Check size={13} />} onClick={confirm}
          disabled={!solution || saving || expecting === 'R'}>
          {saving ? '保存中…' : '确定对齐'}
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => setTool('select')}>退出</Button>
      </div>

      {pairs.length > 0 && (
        <div className="align-pairs">
          {pairs.map((p, i) => (
            <span key={i} className={`pair-chip${hover === i ? ' hot' : ''}`}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <b>#{i + 1}</b>
              <i style={{ background: p.a ? COLORS.alignL : 'var(--bg-4)' }} />
              <i style={{ background: p.b ? COLORS.alignR : 'var(--bg-4)' }} />
              <button title="删除该点对" onClick={() => deletePair(i)}><X size={10} /></button>
            </span>
          ))}
        </div>
      )}

      <div className="align-panes">
        <Pane asset={leftAsset} color={COLORS.alignL} sideLabel="左" highlight={hover}
          pts={pairs.filter(p => p.a).map(p => p.a!)} onPick={pickL} active={expecting === 'L'} />
        {right ? (
          <Pane key={right.id} asset={right} color={COLORS.alignR} sideLabel="右" highlight={hover}
            pts={pairs.filter(p => p.b).map(p => p.b!)} onPick={pickR} active={expecting === 'R'} />
        ) : (
          <div className="align-pane">
            <Empty title="在上方选择右侧比对图">
              建议先与 [主图] 对齐以接入统一坐标；左键取点（左红右蓝交替），右键拖图，滚轮缩放；至少 {MIN_PAIRS} 对
            </Empty>
          </div>
        )}
      </div>
    </div>
  )
}
