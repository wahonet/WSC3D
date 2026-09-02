import { useMemo, useState } from 'react'
import { Box, ChevronRight, Image as ImageIcon, Search } from 'lucide-react'
import { thumbUrl } from '../api'
import { fmtBytes } from '../lib/format'
import { useApp } from '../store/useApp'
import type { AssetBrief, StoneNode } from '../types'
import { Badge, Empty } from './ui'

export default function StoneTree() {
  const stones = useApp(s => s.stones)
  const curAsset = useApp(s => s.curAsset)
  const curStone = useApp(s => s.curStone)
  const openAsset = useApp(s => s.openAsset)

  const [q, setQ] = useState('')
  const [closedStones, setClosedStones] = useState<Set<number>>(new Set())
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())

  const toggle = <T,>(set: Set<T>, v: T) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n }

  const query = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!query) return stones
    return stones
      .map(s => {
        const hitStone = s.name.toLowerCase().includes(query) || s.code.toLowerCase().includes(query)
        const groups = s.groups.map(g => ({
          ...g, assets: hitStone ? g.assets : g.assets.filter(a => a.filename.toLowerCase().includes(query)),
        }))
        return { ...s, groups, _hit: hitStone || groups.some(g => g.assets.length > 0) }
      })
      .filter(s => s._hit)
  }, [stones, query])

  if (stones.length === 0) {
    return <Empty icon={<ImageIcon size={22} />} title="暂无画像石">把素材放入 <span className="mono">assets/stones/</span> 后点击右上角「重新扫描」</Empty>
  }

  return (
    <>
      <div className="tree-search">
        <div className="wrap">
          <Search size={13} />
          <input className="input sm" placeholder="搜索石头 / 文件名" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      <div className="tree">
        {filtered.map(s => {
          const open = query ? true : !closedStones.has(s.id)
          const selected = curStone?.id === s.id
          return (
            <div key={s.id}>
              <div className={`stone-card${open ? ' open' : ''}${selected ? ' on' : ''}`}
                onClick={() => setClosedStones(toggle(closedStones, s.id))}>
                {s.master_asset_id
                  ? <img className="thumb" src={thumbUrl(s.master_asset_id)} alt="" loading="lazy" />
                  : <div className="thumb"><ImageIcon size={16} /></div>}
                <div className="meta">
                  <div className="name truncate">{s.name}</div>
                  <div className="sline">
                    <span className="mono">{s.code}</span>
                    <span>{s.asset_count} 件</span>
                    {s.annotation_count > 0 && <span>{s.annotation_count} 标注</span>}
                  </div>
                </div>
                <ChevronRight size={14} className="chev" />
              </div>
              {open && (
                <div className="tree-groups">
                  {s.groups.filter(g => g.assets.length > 0).map(g => {
                    const gid = `${s.id}:${g.key}`
                    const gOpen = !!query || openGroups.has(gid) || g.assets.some(a => a.id === curAsset?.id)
                    return (
                      <div key={g.key}>
                        <div className={`grp-row${gOpen ? ' open' : ''}`} onClick={() => setOpenGroups(toggle(openGroups, gid))}>
                          <ChevronRight size={12} className="chev" />
                          <span>{g.label}</span>
                          <span className="n">{g.assets.length}</span>
                        </div>
                        {gOpen && g.assets.map(a => (
                          <Leaf key={a.id} a={a} stone={s} isModel={g.key === 'model'}
                            on={curAsset?.id === a.id} onOpen={() => openAsset(s, a)} />
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {filtered.length === 0 && <Empty>没有匹配「{q}」的结果</Empty>}
      </div>
    </>
  )
}

function Leaf({ a, isModel, on, onOpen }: {
  a: AssetBrief; stone: StoneNode; isModel: boolean; on: boolean; onOpen: () => void
}) {
  return (
    <div className={`leaf${on ? ' on' : ''}`} onClick={onOpen} title={a.filename}>
      {isModel
        ? <span className="licon"><Box size={15} /></span>
        : <img className="lthumb" src={thumbUrl(a.id)} alt="" loading="lazy" />}
      <span className="lmeta">
        <span className="lname">{isModel ? a.kind_label : a.filename}</span>
        <span className="lsub">
          {a.width > 0 && <span>{a.width}x{a.height}</span>}
          <span>{fmtBytes(a.bytes)}</span>
          {a.annotation_count > 0 && <span>· {a.annotation_count} 标注</span>}
        </span>
      </span>
      <span className="lbadges">
        {a.is_master && <Badge tone="accent" title="主图：坐标系原点">主图</Badge>}
        {!a.is_master && a.in_frame && <Badge tone="green" title="已接入主图坐标链">链</Badge>}
      </span>
    </div>
  )
}
