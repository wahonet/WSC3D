import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react'
import {
  ChevronDown, ChevronRight, EyeOff, GitBranch, Link2, ListTree, Plus, Search, Sparkles, Tags, Wand2,
} from 'lucide-react'
import { LEVELS, LEVEL_LABEL, LEVEL_SHORT } from '../../lib/constants'
import { ancestors, buildTree, descendantIds, flatten, hasGeometry, isStructural, progress, type TreeNode } from '../../lib/tree'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { Annotation, Level } from '../../types'
import { Badge, Button, Chip, Empty } from '../ui'
import SkeletonDialog from './SkeletonDialog'

type Filter = 'all' | 'candidate' | 'nogeo' | 'orphan' | 'unlinked'
const FILTERS: [Filter, string][] = [['all', '全部'], ['candidate', '候选'], ['nogeo', '无框'], ['orphan', '未归类'], ['unlinked', '未关联释文']]

/** 节点在当前图上的可见性：自有 / 投影 / 无几何 / 在别的图上且不可投影 */
type Vis = 'own' | 'proj' | 'none' | 'hidden'

export default function StructurePanel() {
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const curStone = useApp(s => s.curStone)
  const curAsset = useApp(s => s.curAsset)
  const projItems = useApp(s => s.projItems)
  const selectedId = useApp(s => s.selectedId)
  const multiSel = useApp(s => s.multiSel)
  const select = useApp(s => s.select)
  const toggleMulti = useApp(s => s.toggleMulti)
  const setMultiSel = useApp(s => s.setMultiSel)
  const setTreeOrder = useApp(s => s.setTreeOrder)
  const flyTo = useApp(s => s.flyToAnnotation)
  const batchPatch = useApp(s => s.batchPatch)
  const removeAnnotations = useApp(s => s.removeAnnotations)
  const adopt = useApp(s => s.adopt)
  const runAutoParent = useApp(s => s.runAutoParent)
  const createPlaceholder = useApp(s => s.createPlaceholder)
  const openAsset = useApp(s => s.openAsset)
  const stones = useApp(s => s.stones)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null | 'root'>(null)
  const [dropMenu, setDropMenu] = useState<{ src: number; dst: number } | null>(null)
  const [skeletonOpen, setSkeletonOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newLevel, setNewLevel] = useState<Level>('figure')
  const [confirmDel, setConfirmDel] = useState(false)

  const nodes = useMemo(() => stoneAnnos.filter(isStructural), [stoneAnnos])
  const byId = useMemo(() => new Map(nodes.map(a => [a.id, a])), [nodes])
  const tree = useMemo(() => buildTree(nodes), [nodes])
  const prog = useMemo(() => progress(nodes), [nodes])
  const projIds = useMemo(() => new Set(projItems.map(p => p.id)), [projItems])
  const selected = selectedId != null ? byId.get(selectedId) ?? null : null
  const selIds = useMemo(() => new Set(multiSel.length ? multiSel : (selectedId != null ? [selectedId] : [])), [multiSel, selectedId])

  const vis = (a: Annotation): Vis => {
    if (!hasGeometry(a)) return 'none'
    if (curAsset && a.asset_id === curAsset.id) return 'own'
    if (projIds.has(a.id)) return 'proj'
    return 'hidden'
  }

  const matches = (a: Annotation) => {
    if (filter === 'candidate' && a.review_status !== 'candidate') return false
    if (filter === 'nogeo' && hasGeometry(a)) return false
    if (filter === 'orphan' && (a.parent_id != null || a.level === 'whole')) return false
    if (filter === 'unlinked' && a.desc_text) return false
    if (query) {
      const q = query.trim().toLowerCase()
      if (!a.label.toLowerCase().includes(q) && !(a.note || '').toLowerCase().includes(q)
        && !(LEVEL_LABEL[a.level] ?? '').includes(q)) return false
    }
    return true
  }
  const filtering = filter !== 'all' || query.trim() !== ''

  /** 显示行：正常为折叠后的先序树；筛选时为匹配节点的平铺列表（带路径） */
  const rows: TreeNode[] = useMemo(() => {
    if (!filtering) return flatten(tree, collapsed)
    const out: TreeNode[] = []
    const walk = (ns: TreeNode[]) => { for (const n of ns) { if (matches(n.a)) out.push({ ...n, depth: 0 }); walk(n.children) } }
    walk(tree)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, collapsed, filter, query])

  useEffect(() => { setTreeOrder(rows.map(r => r.a.id)) }, [rows, setTreeOrder])

  // 选中节点时自动展开它的祖先，保证在树里可见
  useEffect(() => {
    if (!selected) return
    const anc = ancestors(byId, selected)
    if (anc.some(x => collapsed.has(x.id))) {
      setCollapsed(prev => { const n = new Set(prev); for (const x of anc) n.delete(x.id); return n })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const toggleCollapse = (id: number, e: MouseEvent) => {
    e.stopPropagation()
    setCollapsed(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  const collapseAll = (depth: number) => {
    const n = new Set<number>()
    const walk = (ns: TreeNode[]) => { for (const x of ns) { if (x.depth >= depth && x.children.length) n.add(x.a.id); walk(x.children) } }
    walk(tree)
    setCollapsed(n)
  }

  const onRowClick = (a: Annotation, e: MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleMulti(a.id); return }
    select(a.id === selectedId && multiSel.length === 0 ? null : a.id)
  }
  const locate = (a: Annotation) => {
    const v = vis(a)
    if (v === 'own' || v === 'proj') { flyTo(a.id); return }
    if (v === 'none') { toast.warn(`「${a.label}」还没有几何：选中它后用标注工具在图上绘制即可挂接`); return }
    // 在别的图上且无法投影到本图：切到它所在的图
    const st = stones.find(s => s.id === a.stone_id)
    const asset = st?.groups.flatMap(g => g.assets).find(x => x.id === a.asset_id)
    if (st && asset) { openAsset(st, asset).then(() => flyTo(a.id)) }
  }

  /* ---------- 拖拽换父 ---------- */
  const onDragStart = (a: Annotation, e: DragEvent) => { setDragId(a.id); e.dataTransfer.effectAllowed = 'move' }
  const canDrop = (dst: number | 'root') => {
    if (dragId == null) return false
    if (dst === 'root') return true
    if (dst === dragId) return false
    return !descendantIds(nodes, dragId).has(dst)
  }
  const onDrop = (dst: number | 'root', e: DragEvent) => {
    e.preventDefault()
    const src = dragId
    setDragId(null); setOverId(null)
    if (src == null || !canDrop(dst)) return
    const moving = selIds.has(src) && selIds.size > 1 ? [...selIds] : [src]
    if (dst === 'root') { batchPatch(moving.map(id => ({ id, clear_parent: true }))); return }
    const d = byId.get(dst), s = byId.get(src)
    if (moving.length === 1 && d && s && !hasGeometry(d) && hasGeometry(s)) { setDropMenu({ src, dst }); return }
    batchPatch(moving.filter(id => id !== dst && !descendantIds(nodes, id).has(dst)).map(id => ({ id, parent_id: dst })))
  }

  /* ---------- 批量 ---------- */
  const batchIds = multiSel.length > 1 ? multiSel : []
  const batchLevel = (lv: Level) => batchPatch(batchIds.map(id => ({ id, level: lv })))
  const batchPromote = () => batchPatch(batchIds.map(id => ({ id, review_status: 'reviewed' as const })))

  const addChild = async () => {
    const label = newLabel.trim()
    if (!label) return
    const parentId = selected ? selected.id : null
    await createPlaceholder(parentId, newLevel, label)
    setNewLabel('')
    setAdding(false)
  }

  if (!curStone) return <Empty icon={<ListTree size={22} />} title="未选择画像石">打开任意素材后，这里显示该石的图像结构树</Empty>

  return (
    <div className="stree">
      <div className="stree-bar">
        <div className="tree-search" style={{ padding: 0, flex: 1 }}>
          <div className="wrap">
            <Search size={13} />
            <input className="input sm" placeholder="搜名称 / 层级" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
        </div>
        <Button size="xs" variant="ghost" icon={<Sparkles size={12} />} onClick={() => setSkeletonOpen(true)}
          title="从总述与分层释文解析出 层 / 场景 / 人物 / 榜题 节点（预览后创建）">骨架</Button>
        <Button size="xs" variant="ghost" icon={<Wand2 size={12} />} onClick={() => runAutoParent()}
          title="把所有尚无父级的节点（含机器候选）按几何包含归入所在的层 / 场景">归类</Button>
        <Button size="xs" variant={adding ? 'primary' : 'ghost'} icon={<Plus size={12} />} onClick={() => setAdding(v => !v)}
          title={selected ? `在「${selected.label}」下新建子节点（先无几何）` : '新建顶层节点（先无几何）'}>节点</Button>
      </div>
      {adding && (
        <div className="stree-add">
          <span className="hint">{selected ? <>在「<b>{selected.label}</b>」下新建：</> : '新建顶层节点：'}</span>
          <select className="select sm" style={{ width: 96 }} value={newLevel} onChange={e => setNewLevel(e.target.value as Level)}>
            {LEVELS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <input className="input sm" autoFocus placeholder="名称，回车创建" value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addChild(); if (e.key === 'Escape') setAdding(false) }} />
          <Button size="xs" variant="primary" onClick={addChild} disabled={!newLabel.trim()}>创建</Button>
        </div>
      )}
      <div className="stree-filters">
        {FILTERS.map(([k, lb]) => {
          const n = k === 'all' ? prog.total : k === 'candidate' ? prog.candidates : k === 'nogeo' ? prog.noGeometry
            : k === 'orphan' ? prog.orphans : prog.total - prog.linked
          if (k !== 'all' && n === 0) return null
          return <Chip key={k} size="sm" on={filter === k} onClick={() => setFilter(k)}>{lb} {n}</Chip>
        })}
        <span style={{ flex: 1 }} />
        {!filtering && tree.length > 0 && (
          <>
            <button className="stree-link" onClick={() => collapseAll(1)} title="只展开到层">层</button>
            <button className="stree-link" onClick={() => collapseAll(2)} title="展开到场景">景</button>
            <button className="stree-link" onClick={() => setCollapsed(new Set())} title="全部展开">全</button>
          </>
        )}
      </div>

      {batchIds.length > 0 && (
        <div className="stree-batch">
          <b>已选 {batchIds.length}</b>
          <select className="select sm" style={{ width: 92 }} defaultValue="" onChange={e => { if (e.target.value) batchLevel(e.target.value as Level); e.target.value = '' }}>
            <option value="">设层级…</option>
            {LEVELS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          {batchIds.some(id => byId.get(id)?.review_status === 'candidate') && (
            <Button size="xs" variant="primary" onClick={batchPromote}>转正</Button>
          )}
          <Button size="xs" onClick={() => runAutoParent(batchIds)} title="按几何包含归类所选">归类</Button>
          {confirmDel ? (
            <>
              <Button size="xs" variant="danger" onClick={() => { removeAnnotations(batchIds); setConfirmDel(false) }}>确认删除</Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirmDel(false)}>取消</Button>
            </>
          ) : <Button size="xs" variant="danger" onClick={() => setConfirmDel(true)}>删除</Button>}
          <span style={{ flex: 1 }} />
          <Button size="xs" variant="ghost" onClick={() => setMultiSel([])}>取消多选</Button>
        </div>
      )}

      {dropMenu && (() => {
        const s = byId.get(dropMenu.src), d = byId.get(dropMenu.dst)
        if (!s || !d) return null
        return (
          <div className="stree-batch" style={{ borderColor: 'var(--cyan)' }}>
            <span className="hint" style={{ flex: 1 }}>把「<b>{s.label}</b>」拖到无框节点「<b>{d.label}</b>」：</span>
            <Button size="xs" variant="primary" onClick={() => { adopt(dropMenu.dst, dropMenu.src); setDropMenu(null) }}
              title="用它的几何作为该节点的几何，并删除来源（常用于把 SAM 候选并入释文生成的骨架节点）">并入几何</Button>
            <Button size="xs" onClick={() => { batchPatch([{ id: dropMenu.src, parent_id: dropMenu.dst }]); setDropMenu(null) }}>设为子级</Button>
            <Button size="xs" variant="ghost" onClick={() => setDropMenu(null)}>取消</Button>
          </div>
        )
      })()}

      <div className={`stree-root${overId === 'root' && canDrop('root') ? ' over' : ''}`}
        onDragOver={e => { if (canDrop('root')) { e.preventDefault(); setOverId('root') } }}
        onDragLeave={() => setOverId(null)} onDrop={e => onDrop('root', e)}>
        {dragId != null ? '放到这里 = 移到顶层' : (
          <>
            {['whole', 'layer', 'scene', 'figure', 'inscription'].map(lv => prog.byLevel[lv] ? (
              <span key={lv}>{LEVEL_LABEL[lv]} <b>{prog.byLevel[lv]}</b></span>
            ) : null)}
            <span>释文 <b>{prog.linked}</b></span>
            <span>概念 <b>{prog.withConcept}</b></span>
          </>
        )}
      </div>

      <div className="stree-list">
        {nodes.length === 0 && (
          <Empty icon={<ListTree size={22} />} title="还没有结构节点">
            点「骨架」从释文生成 层 / 场景 / 人物 / 榜题 节点，或用标注工具在图上直接绘制。
          </Empty>
        )}
        {nodes.length > 0 && rows.length === 0 && <Empty>没有符合筛选的节点</Empty>}
        {rows.map(({ a, children, depth }) => {
          const on = selIds.has(a.id)
          const v = vis(a)
          const isCand = a.review_status === 'candidate'
          const path = filtering ? ancestors(byId, a).map(x => x.label).join(' ? ') : ''
          const dropOk = overId === a.id && canDrop(a.id)
          return (
            <div key={a.id}
              className={`tn${on ? ' on' : ''}${isCand ? ' cand' : ''}${a.review_status === 'rejected' ? ' rejected' : ''}${dropOk ? ' over' : ''}${dragId === a.id ? ' dragging' : ''}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              draggable onDragStart={e => onDragStart(a, e)} onDragEnd={() => { setDragId(null); setOverId(null) }}
              onDragOver={e => { if (canDrop(a.id)) { e.preventDefault(); setOverId(a.id) } }}
              onDragLeave={() => setOverId(cur => (cur === a.id ? null : cur))}
              onDrop={e => onDrop(a.id, e)}
              onClick={e => onRowClick(a, e)} onDoubleClick={() => locate(a)}
              title={`${LEVEL_LABEL[a.level] ?? '未定层级'}${path ? ` · ${path}` : ''}${v === 'hidden' ? ' · 在其他图上，双击切换' : ''}`}>
              {!filtering && children.length > 0
                ? <button className="chev" onClick={e => toggleCollapse(a.id, e)}>{collapsed.has(a.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button>
                : <span className="chev" />}
              <span className="sw" style={{ background: a.color }} />
              <span className={`lv${a.level ? '' : ' none'}`}>{LEVEL_SHORT[a.level] ?? '?'}</span>
              <span className="lb">
                {a.label}
                {path && <span className="path">{path}</span>}
              </span>
              {isCand && <Badge tone="cyan" title="机器候选：命名后转正，或删除">候选</Badge>}
              {v === 'none' && <Badge outline title="尚无几何：选中后在图上绘制即挂接，或把候选拖到它上面并入">无框</Badge>}
              {v === 'proj' && <Badge tone="violet" title="在其他图上，以投影显示">投影</Badge>}
              {v === 'hidden' && <span className="ic" title="在其他图上且本图未入链"><EyeOff size={11} /></span>}
              {a.desc_text && <span className="ic amber" title="已关联释文"><Link2 size={11} /></span>}
              {a.concept_ids.length > 0 && <span className="ic" title={`${a.concept_ids.length} 个概念`}><Tags size={11} /></span>}
              {children.length > 0 && !filtering && <span className="cnt"><GitBranch size={10} />{children.length}</span>}
            </div>
          )
        })}
      </div>

      {skeletonOpen && <SkeletonDialog stoneId={curStone.id} onClose={() => setSkeletonOpen(false)} />}
    </div>
  )
}
