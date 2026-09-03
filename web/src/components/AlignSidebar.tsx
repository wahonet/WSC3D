import { useMemo, useState } from 'react'
import { Layers2, Link2, Star, Trash2 } from 'lucide-react'
import { alignGeomToOverlay } from '../lib/geometry'
import { fmtTime } from '../lib/format'
import { selectIs2d, useApp } from '../store/useApp'
import type { AlignGeometry } from '../types'
import { Badge, Button, Empty } from './ui'

/** 对齐模块左下：主图、各图入链状态、对齐记录（可重新叠加 / 删除） */
export default function AlignSidebar() {
  const stone = useApp(s => s.curStone)
  const asset = useApp(s => s.curAsset)
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const overlay = useApp(s => s.overlay)
  const is2d = useApp(selectIs2d)
  const openAsset = useApp(s => s.openAsset)
  const makeMaster = useApp(s => s.makeMaster)
  const remove = useApp(s => s.removeAnnotation)
  const setOverlay = useApp(s => s.setOverlayOpacity)
  const setOverlaySpec = useApp(s => s.setOverlaySpec)
  const removeOverlay = useApp(s => s.removeOverlay)
  const [confirmDel, setConfirmDel] = useState<number | null>(null)

  const twoD = useMemo(() => stone ? stone.groups.filter(g => g.key !== 'model').flatMap(g => g.assets) : [], [stone])
  const byId = useMemo(() => new Map(twoD.map(a => [a.id, a])), [twoD])
  const records = useMemo(() => stoneAnnos.filter(a => a.atype === 'align').sort((x, y) => y.id - x.id), [stoneAnnos])
  const master = twoD.find(a => a.is_master)

  if (!stone) return <Empty icon={<Layers2 size={22} />} title="未选择画像石">在上方列表里打开一张照片或拓片作为左图</Empty>

  return (
    <div className="alignbar">
      <div className="layers-title">坐标系</div>
      <div className="align-master">
        <Star size={12} className="muted" />
        <span className="truncate" title={master?.filename}>主图：{master ? master.filename : '（未指派）'}</span>
        {asset && is2d && !asset.is_master && (
          <Button size="xs" onClick={makeMaster} title="把当前图设为坐标系原点（已有坐标链时自动重定基）">设当前图为主图</Button>
        )}
      </div>
      <div className="align-assets">
        {twoD.map(a => {
          const rmse = a.extra.align_to_master?.rmse_px
          return (
            <div key={a.id} className={`align-asset${asset?.id === a.id ? ' on' : ''}`} onClick={() => openAsset(stone, a)} title={a.filename}>
              <span className="truncate">{a.filename}</span>
              {a.is_master ? <Badge tone="accent">主图</Badge>
                : a.in_frame ? <Badge tone="green" title={rmse != null ? `RMSE ${rmse.toFixed(1)} px` : ''}>链{rmse != null ? ` ${rmse.toFixed(1)}` : ''}</Badge>
                  : <Badge outline>未入链</Badge>}
            </div>
          )
        })}
      </div>
      <div className="hint" style={{ padding: '4px 10px 8px' }}>
        未入链的图：在上方打开它作为左图，右侧选主图（或任一已入链的图）取 4 对以上同名点，「确定对齐」即接入坐标系。
      </div>

      <div className="layers-title">对齐记录 · {records.length}</div>
      {records.length === 0 && <div className="hint" style={{ padding: '0 10px 8px' }}>还没有对齐记录。</div>}
      <div className="align-records">
        {records.map(r => {
          const g = r.geometry as unknown as AlignGeometry
          const left = byId.get(r.asset_id), right = byId.get(g.target_asset_id)
          const applied = overlay?.assetId === g.target_asset_id && asset?.id === r.asset_id
          return (
            <div key={r.id} className={`align-rec${applied ? ' on' : ''}`}>
              <div className="head">
                <Link2 size={11} className="muted" />
                <span className="truncate">{left?.filename ?? `#${r.asset_id}`}</span>
                <span className="muted">→</span>
                <span className="truncate">{right?.filename ?? `#${g.target_asset_id}`}</span>
              </div>
              <div className="meta">
                <Badge mono tone={(r.value ?? 0) < 8 ? 'green' : (r.value ?? 0) < 25 ? 'amber' : 'red'}>RMSE {(r.value ?? 0).toFixed(1)} px</Badge>
                <span className="muted">{g.pairs?.length ?? 0} 对 · {fmtTime(r.created_at)}</span>
                <span style={{ flex: 1 }} />
                {left && (applied
                  ? <Button size="xs" variant="ghost" onClick={removeOverlay}>移除叠加</Button>
                  : <Button size="xs" onClick={async () => {
                      if (asset?.id !== left.id) await openAsset(stone, left)
                      setOverlaySpec({ assetId: g.target_asset_id, opacity: 0.5, transform: alignGeomToOverlay(g) })
                    }} title="在左图上叠加右图查看配准效果">叠加</Button>)}
                {confirmDel === r.id ? (
                  <>
                    <Button size="xs" variant="danger" onClick={() => { remove(r.id); setConfirmDel(null) }}>确认</Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmDel(null)}>取消</Button>
                  </>
                ) : <Button size="xs" variant="ghost" icon={<Trash2 size={11} />} onClick={() => setConfirmDel(r.id)} title="删除记录（坐标链保留）" />}
              </div>
              {applied && overlay && (
                <input type="range" className="range" min={0} max={1} step={0.02} value={overlay.opacity}
                  onChange={e => setOverlay(Number(e.target.value))} title="叠加透明度" />
              )}
            </div>
          )
        })}
      </div>
      {records.length > 0 && <div className="hint" style={{ padding: '0 10px 8px' }}>叠加的透明度也可在首页「图层 · 图像叠加」里调。</div>}
    </div>
  )
}
