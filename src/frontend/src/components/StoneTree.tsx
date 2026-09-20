import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

  // List covers are display choices; choosing one must not assign an alignment master.
  const thumbnailIds = useMemo(() => new Map(stones.map(s => {
    const images = ['photo', 'rubbing', 'photo_part'].flatMap(kind =>
      s.groups.find(g => g.key === kind)?.assets ?? [])
    return [s.id, s.master_asset_id ?? images[0]?.id]
  })), [stones])

  const [q, setQ] = useState('')
  const [openStones, setOpenStones] = useState<Set<string>>(new Set())
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const treeRef = useRef<HTMLDivElement>(null)
  const revealRef = useRef<string | null>(null)

  useEffect(() => {
    if (!curStone) return
    revealRef.current = curStone.id
    setQ('')
    setOpenStones(previous => new Set([...previous, curStone.id]))
  }, [curStone?.id, curAsset?.id])

  useLayoutEffect(() => {
    const id = revealRef.current
    const tree = treeRef.current
    if (!id || !tree || !openStones.has(id)) return
    const row = Array.from(tree.querySelectorAll<HTMLElement>('[data-stone-id]'))
      .find(item => item.dataset.stoneId === id)
    if (!row) return
    const frame = requestAnimationFrame(() => {
      // Scroll this pane only; keep the stone heading and nearby stones visible.
      const pane = tree.closest<HTMLElement>('.pane-b') ?? tree
      pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12
      revealRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [openStones, stones, q])

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
    return <Empty icon={<ImageIcon size={22} />} title="暂无画像石">请先在 <span className="mono">resources/stones/</span> 中整理素材并登记档案。</Empty>
  }

  return (
    <>
      <div className="tree-search">
        <div className="wrap">
          <Search size={13} />
          <input className="input sm" placeholder="搜索石头 / 文件名" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </div>
      <div className="tree" ref={treeRef}>
        {filtered.map(s => {
          const open = !!query || openStones.has(s.id)
          const selected = curStone?.id === s.id
          const thumbnailId = thumbnailIds.get(s.id)
          return (
            <div key={s.id}>
              <div data-stone-id={s.id} aria-current={selected ? 'true' : undefined} className={`stone-card${open ? ' open' : ''}${selected ? ' on' : ''}`}
                onClick={() => setOpenStones(toggle(openStones, s.id))}>
                {thumbnailId
                  ? <img className="thumb" src={thumbUrl(thumbnailId)} alt={`${s.code} ${s.name}缩略图`} loading="lazy" />
                  : <div className="thumb" title="暂无图像"><ImageIcon size={16} /></div>}
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
