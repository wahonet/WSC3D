import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Crosshair, Eraser, Link2, RotateCcw, Save, SquareDashed, Trash2, Unlink, X } from 'lucide-react'
import { parentSuggestions, patchAnnotation, type AnnotationPatchBody } from '../../api'
import { ATYPE_LABEL, LEVELS, LEVEL_LABEL, PALETTE, REVIEW_LABEL } from '../../lib/constants'
import { fmtTime, fmtValue, rgba } from '../../lib/format'
import { ancestors, hasGeometry, isStructural } from '../../lib/tree'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { Annotation, GeometryIntent, Level, ParentSuggestion, Quality, ReviewStatus, Semantics } from '../../types'
import { EMPTY_SEMANTICS } from '../../types'
import { Badge, Button, Empty, Field } from '../ui'
import ConceptPicker from './ConceptPicker'

/** SOP 一层类别 -> 新增概念时的默认分类 */
const CATEGORY_TO_CONCEPT_CAT: Record<string, string> = {
  'figure-deity': 'cat-imagination-deity', 'figure-immortal': 'cat-imagination-deity',
  'figure-mythic-ruler': 'cat-person-figure', 'figure-loyal-assassin': 'cat-person-figure',
  'figure-filial-son': 'cat-person-figure', 'figure-virtuous-woman': 'cat-person-figure',
  'figure-music-dance': 'cat-person-role', 'chariot-procession': 'cat-artifact-vehicle',
  'mythic-creature': 'cat-imagination-beast', 'celestial': 'cat-nature-sky',
  'daily-life-scene': 'cat-story-theme', 'architecture': 'cat-artifact-architecture',
  'inscription': 'cat-inscription-bangti', 'pattern-border': 'cat-pattern-geometric',
}
const CONTAINER_LEVELS: Level[] = ['whole', 'band', 'layer', 'scene', 'figure']

/** 表单草稿：与标注一一对应的可编辑字段 */
interface Draft {
  label: string
  level: Level
  seq: number | null
  category: string
  review_status: ReviewStatus
  parent_id: number | null
  concept_ids: number[]
  semantics: Semantics
  quality: Quality
  geometry_intent: GeometryIntent
  color: string
  note: string
}
const fromAnno = (a: Annotation): Draft => ({
  label: a.label, level: a.level, seq: a.seq, category: a.category, review_status: a.review_status,
  parent_id: a.parent_id, concept_ids: [...a.concept_ids].sort((x, y) => x - y),
  semantics: { ...EMPTY_SEMANTICS, ...a.semantics, inscription: { ...EMPTY_SEMANTICS.inscription, ...a.semantics?.inscription } },
  quality: a.quality, geometry_intent: a.geometry_intent, color: a.color, note: a.note,
})
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y)

/** 草稿与当前标注的差异 -> PATCH 体；无差异返回 null */
function diff(d: Draft, a: Annotation): AnnotationPatchBody | null {
  const base = fromAnno(a)
  const p: AnnotationPatchBody = {}
  if (d.label.trim() && d.label.trim() !== base.label) p.label = d.label.trim()
  if (d.level !== base.level) p.level = d.level
  if (!same(d.seq, base.seq)) { if (d.seq == null) p.clear_seq = true; else p.seq = d.seq }
  if (d.category !== base.category) p.category = d.category
  if (d.review_status !== base.review_status) p.review_status = d.review_status
  if (!same(d.parent_id, base.parent_id)) { if (d.parent_id == null) p.clear_parent = true; else p.parent_id = d.parent_id }
  if (!same([...d.concept_ids].sort((x, y) => x - y), base.concept_ids)) p.concept_ids = d.concept_ids
  if (!same(d.semantics, base.semantics)) p.semantics = d.semantics
  if (d.quality !== base.quality) p.quality = d.quality
  if (d.geometry_intent !== base.geometry_intent) p.geometry_intent = d.geometry_intent
  if (d.color !== base.color) p.color = d.color
  if (d.note !== base.note) p.note = d.note
  return Object.keys(p).length ? p : null
}

export default function NodeDetail() {
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const annos = useApp(s => s.annos)
  const selectedId = useApp(s => s.selectedId)
  const multiSel = useApp(s => s.multiSel)
  const a = useMemo(() => stoneAnnos.find(x => x.id === selectedId) ?? annos.find(x => x.id === selectedId) ?? null,
    [stoneAnnos, annos, selectedId])
  if (multiSel.length > 1) return <Empty title={`已多选 ${multiSel.length} 个节点`}>用结构树上方的批量栏设层级 / 转正 / 归类 / 删除；Ctrl+点击可增减选择</Empty>
  if (!a) return <Empty icon={<SquareDashed size={22} />} title="未选中节点">在左侧结构树或图上点选一个实体，在这里填写它的层级、父级、类别、概念与图像志描述，然后保存</Empty>
  return isStructural(a) ? <StructuralForm key={a.id} a={a} /> : <RecordDetail key={a.id} a={a} />
}

/* ------------------------------------------------------------------ 结构节点表单 */
function StructuralForm({ a }: { a: Annotation }) {
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const stones = useApp(s => s.stones)
  const curAsset = useApp(s => s.curAsset)
  const page = useApp(s => s.page)
  const taxonomy = useApp(s => s.taxonomy)
  const update = useApp(s => s.updateAnnotation)
  const remove = useApp(s => s.removeAnnotation)
  const flyTo = useApp(s => s.flyToAnnotation)
  const select = useApp(s => s.select)
  const setPage = useApp(s => s.setPage)
  const setTool = useApp(s => s.setTool)

  const [d, setD] = useState<Draft>(() => fromAnno(a))
  const baseRef = useRef<Draft>(fromAnno(a))
  const [sugs, setSugs] = useState<ParentSuggestion[]>([])
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const patch = diff(d, a)
  const dirty = patch != null

  // 标注在别处被改动（如快捷键转正、拖拽换父）：草稿里没动过的字段跟着更新，动过的保留
  useEffect(() => {
    const nb = fromAnno(a)
    setD(cur => {
      const next: Draft = { ...cur }
      for (const k of Object.keys(nb) as (keyof Draft)[]) {
        if (same(cur[k], baseRef.current[k])) (next as unknown as Record<string, unknown>)[k] = nb[k]
      }
      return next
    })
    baseRef.current = nb
  }, [a])

  // 切换到别的节点 / 离开页面时，未保存的修改自动保存
  const latest = useRef({ patch, id: a.id })
  latest.current = { patch, id: a.id }
  useEffect(() => () => {
    const { patch: p, id } = latest.current
    if (p) patchAnnotation(id, p).then(() => { useApp.getState().refreshAnnos(); toast.ok('已自动保存上一个节点的修改') }).catch(e => toast.error(e))
  }, [])

  const byId = useMemo(() => new Map(stoneAnnos.map(x => [x.id, x])), [stoneAnnos])
  const parent = d.parent_id != null ? byId.get(d.parent_id) ?? null : null
  const path = ancestors(byId, a)
  const geo = hasGeometry(a)
  const asset = stones.flatMap(s => s.groups.flatMap(g => g.assets)).find(x => x.id === a.asset_id)
  const containers = useMemo(() => stoneAnnos.filter(x => isStructural(x) && x.id !== a.id && x.review_status !== 'candidate'
    && (CONTAINER_LEVELS.includes(x.level) || x.level === '')).sort((x, y) => (x.level < y.level ? -1 : 1)), [stoneAnnos, a.id])
  const children = useMemo(() => stoneAnnos.filter(x => x.parent_id === a.id), [stoneAnnos, a.id])

  useEffect(() => {
    if (!geo) { setSugs([]); return }
    let alive = true
    parentSuggestions(a.id).then(r => { if (alive) setSugs(r) }).catch(() => { if (alive) setSugs([]) })
    return () => { alive = false }
  }, [a.id, a.asset_id, a.geometry, geo])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(cur => ({ ...cur, [k]: v }))
  const setSem = (s: Partial<Semantics>) => setD(cur => ({ ...cur, semantics: { ...cur.semantics, ...s } }))
  const setInscr = (s: Partial<Semantics['inscription']>) =>
    setD(cur => ({ ...cur, semantics: { ...cur.semantics, inscription: { ...cur.semantics.inscription, ...s } } }))

  const save = async (extra?: AnnotationPatchBody) => {
    const p = { ...(diff(d, a) ?? {}), ...(extra ?? {}) }
    if (Object.keys(p).length === 0) return
    setSaving(true)
    const r = await update(a.id, p)
    setSaving(false)
    if (r) toast.ok(`已保存「${r.label}」`)
  }
  const reset = () => setD(fromAnno(a))
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save() }
  }

  const isCand = a.review_status === 'candidate'
  const isInscr = d.level === 'inscription'
  const semOpen = isInscr || !!(d.semantics.pre_iconographic || d.semantics.iconographic || d.semantics.iconological) || ['scene', 'figure'].includes(d.level)

  return (
    <div className="ndetail" onKeyDown={onKey}>
      {/* ---------- 名称 / 层级 / 次序 ---------- */}
      <div className="nd-head">
        <span className="sw" style={{ background: d.color }} />
        <input className="nd-label" value={d.label} placeholder="节点名称" onChange={e => set('label', e.target.value)} />
        <select className="select sm" style={{ width: 92 }} value={d.level} onChange={e => set('level', e.target.value as Level)} title="结构层级">
          <option value="">层级…</option>
          {LEVELS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <input className="input sm nd-seq" type="number" placeholder="序" title="同级次序（如右起第几）" value={d.seq ?? ''}
          onChange={e => set('seq', e.target.value === '' ? null : Number(e.target.value))} />
      </div>
      {path.length > 0 && (
        <div className="nd-path">
          {path.map(p => <button key={p.id} className="stree-link" onClick={() => select(p.id)}>{p.label}</button>)}
          <span className="muted">? {a.label}</span>
        </div>
      )}

      {/* ---------- 状态 ---------- */}
      <div className="nd-row">
        <span className="nd-k">状态</span>
        <div className="chips">
          {(Object.keys(REVIEW_LABEL) as ReviewStatus[]).map(k => (
            <button key={k} className={`chip sm${d.review_status === k ? ' on' : ''}`} onClick={() => set('review_status', k)}>{REVIEW_LABEL[k]}</button>
          ))}
        </div>
        {isCand && <Button size="xs" variant="primary" icon={<Check size={12} />} onClick={() => save({ review_status: 'reviewed' })} title="确认为实体并保存全部修改（R）">转正并保存</Button>}
      </div>
      {isCand && <div className="hint" style={{ margin: '-2px 0 4px 44px' }}>机器候选：改名 + 设层级 + 挂概念后「转正」，不是目标就删除；或在结构树里把它拖到无框节点上「并入几何」。</div>}

      {/* ---------- 父级 ---------- */}
      <div className="nd-row">
        <span className="nd-k">父级</span>
        <div className="nd-v">
          {parent ? (
            <span className="cchip" style={{ background: rgba(parent.color, 0.18), borderColor: rgba(parent.color, 0.6) }}>
              <Badge mono outline>{LEVEL_LABEL[parent.level] ?? '?'}</Badge>
              <button className="stree-link" onClick={() => select(parent.id)}>{parent.label}</button>
              <button onClick={() => set('parent_id', null)} aria-label="脱离父级" title="移到顶层"><X size={10} /></button>
            </span>
          ) : d.level !== 'whole' && <span className="muted">（顶层 · 尚未归类）</span>}
          <select className="select sm" style={{ width: 130 }} value="" onChange={e => { if (e.target.value) set('parent_id', Number(e.target.value)) }}>
            <option value="">{parent ? '改挂到…' : '挂到…'}</option>
            {containers.map(c => <option key={c.id} value={c.id}>{LEVEL_LABEL[c.level] ?? '?'} · {c.label}</option>)}
          </select>
        </div>
      </div>
      {sugs.filter(s => s.id !== d.parent_id).length > 0 && (
        <div className="nd-row sub">
          <span className="nd-k">建议</span>
          <div className="chips">
            {sugs.filter(s => s.id !== d.parent_id).slice(0, 4).map(s => (
              <button key={s.id} className="chip sm" onClick={() => set('parent_id', s.id)}
                title={`本节点 ${Math.round(s.ratio * 100)}% 落在「${s.label}」内；它约为本节点面积的 ${s.area_ratio} 倍`}>
                {LEVEL_LABEL[s.level] ?? '?'} · {s.label} <span className="muted">{Math.round(s.ratio * 100)}%</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---------- 类别 / 概念 ---------- */}
      <div className="nd-row">
        <span className="nd-k">类别</span>
        <select className="select sm" value={d.category} onChange={e => set('category', e.target.value)} title="SOP 一层类别：跨石头互斥大类">
          <option value="">（未定）</option>
          {Object.entries(taxonomy?.sop_categories ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="nd-row">
        <span className="nd-k">概念</span>
        <ConceptPicker value={d.concept_ids} onChange={ids => set('concept_ids', ids)} defaultCategory={CATEGORY_TO_CONCEPT_CAT[d.category]} />
      </div>

      {/* ---------- 释文关联（在文献模块操作） ---------- */}
      <div className="nd-row">
        <span className="nd-k">释文</span>
        <div className="nd-v">
          {a.desc_text ? (
            <>
              <div className="ra-linkedtext" style={{ background: rgba(a.color, 0.14), borderColor: rgba(a.color, 0.55), flex: 1 }}>{a.desc_text}</div>
              <Button size="xs" variant="ghost" icon={<Unlink size={12} />} onClick={() => update(a.id, { clear_link: true })} title="解除关联，文字恢复可编辑">解除</Button>
            </>
          ) : (
            <span className="hint">未关联。{page !== 'library' && <>到「文献」模块拖选一段释文即可关联到本节点。<button className="stree-link" onClick={() => setPage('library')}>去文献 <Link2 size={10} /></button></>}
              {page === 'library' && '在右侧释文中拖选文字，点「关联到本节点」。'}</span>
          )}
        </div>
      </div>

      {/* ---------- 图像志三层 / 榜题 ---------- */}
      <details className="nd-sec" open={semOpen}>
        <summary>{isInscr ? '榜题录文与图像志' : '图像志描述'}<span className="hint">（前图像志 = 只描述看到什么；图像志 = 主题 / 故事；图像学 = 阐释，可多解）</span></summary>
        {isInscr && (
          <>
            <Field label="录文（照原字，异体字保留；缺字用□，补字用〔〕）">
              <textarea className="textarea nd-ta" value={d.semantics.inscription.transcription} onChange={e => setInscr({ transcription: e.target.value })} />
            </Field>
            <div className="nd-2col">
              <Field label="今译">
                <textarea className="textarea nd-ta" value={d.semantics.inscription.translation} onChange={e => setInscr({ translation: e.target.value })} />
              </Field>
              <Field label="释读注（如：某字据陆和九补）">
                <textarea className="textarea nd-ta" value={d.semantics.inscription.notes} onChange={e => setInscr({ notes: e.target.value })} />
              </Field>
            </div>
          </>
        )}
        <Field label="前图像志 · 直观描述">
          <textarea className="textarea nd-ta" placeholder="如：一人右向，冠有双翅，面部泐，衣不蔽膝，左手前伸，右手当胸。" value={d.semantics.pre_iconographic}
            onChange={e => setSem({ pre_iconographic: e.target.value })} />
        </Field>
        <Field label="图像志 · 主题 / 故事识别">
          <textarea className="textarea nd-ta" placeholder="如：祝融（三皇五帝列像之一）。榜题“祝诵氏无所造为……”。" value={d.semantics.iconographic}
            onChange={e => setSem({ iconographic: e.target.value })} />
        </Field>
        <Field label="图像学 · 文化阐释（可多解并存，可引文献）">
          <textarea className="textarea nd-ta" placeholder="如：以远古帝王谱系开篇，呼应下层孝子、刺客的道德叙事（参巫鸿 1989）。" value={d.semantics.iconological}
            onChange={e => setSem({ iconological: e.target.value })} />
        </Field>
      </details>

      {/* ---------- 几何 / 颜色 / 备注 ---------- */}
      <div className="nd-row">
        <span className="nd-k">几何</span>
        <div className="nd-v" style={{ flexWrap: 'wrap' }}>
          {geo ? (
            <>
              <Badge mono outline>{ATYPE_LABEL[a.atype] ?? a.atype}</Badge>
              <span className="hint">在「{asset?.filename ?? `#${a.asset_id}`}」上{asset && !asset.in_frame && !asset.is_master ? '（该图未入链，不能跨图投影）' : ''}</span>
              <Button size="xs" icon={<Crosshair size={12} />} onClick={() => flyTo(a.id)}>定位</Button>
              {confirmClear ? (
                <>
                  <Button size="xs" variant="danger" onClick={() => { update(a.id, { asset_id: a.asset_id, atype: 'none', geometry: {} }); setConfirmClear(false) }}>确认清除</Button>
                  <Button size="xs" variant="ghost" onClick={() => setConfirmClear(false)}>取消</Button>
                </>
              ) : <Button size="xs" variant="ghost" icon={<Eraser size={12} />} onClick={() => setConfirmClear(true)} title="清除几何后可在分割 / 标注模块重新绘制挂接">重画</Button>}
            </>
          ) : (
            <span className="hint">
              <b>无框。</b>选中本节点后{curAsset && !curAsset.kind.startsWith('model')
                ? <>按 <button className="stree-link" onClick={() => setTool('annotate')}>A 绘制</button>即挂接</>
                : '打开一张照片 / 拓片，绘制即挂接'}；或在结构树里把机器候选拖到本节点上「并入几何」。
            </span>
          )}
        </div>
      </div>
      <div className="nd-row">
        <span className="nd-k">颜色</span>
        <span className="swatches">
          {PALETTE.map(c => (
            <button key={c} className={d.color === c ? 'on' : ''} style={{ background: c }} onClick={() => set('color', c)} aria-label={c} />
          ))}
        </span>
      </div>
      <div className="nd-row">
        <span className="nd-k">备注</span>
        <textarea className="textarea nd-ta" value={d.note} placeholder="工作备注（机器候选在此记录来源与分数）" onChange={e => set('note', e.target.value)} />
      </div>

      <details className="nd-sec">
        <summary>高级<span className="hint">（标注质量 / 几何语义 / 元信息）</span></summary>
        <div className="nd-2col">
          <Field label="标注质量">
            <select className="select sm" value={d.quality} onChange={e => set('quality', e.target.value as Quality)}>
              <option value="">（未定）</option>
              {Object.entries(taxonomy?.qualities ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="几何语义">
            <select className="select sm" value={d.geometry_intent} onChange={e => set('geometry_intent', e.target.value as GeometryIntent)}>
              <option value="">（未定）</option>
              {Object.entries(taxonomy?.geometry_intents ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          #{a.id} · {a.tool === 'segment' ? 'SAM 分割产生' : '手工绘制'} · 创建 {fmtTime(a.created_at)}{a.updated_at ? ` · 更新 ${fmtTime(a.updated_at)}` : ''}
          {children.length > 0 && <> · {children.length} 个子节点（删除本节点时它们上挂一级）</>}
        </div>
      </details>

      {/* ---------- 保存栏 ---------- */}
      <div className="nd-save">
        {dirty ? <Badge tone="amber">未保存</Badge> : <span className="hint">已保存</span>}
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <Button size="sm" variant="danger" onClick={() => { remove(a.id); setConfirmDel(false) }}>确认删除</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>取消</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => setConfirmDel(true)} title="删除节点（子节点上挂一级）" />
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={reset} disabled={!dirty}>放弃</Button>
            <Button size="sm" variant="primary" icon={<Save size={13} />} onClick={() => save()} disabled={!dirty || saving} title="Ctrl+S">
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 测量 / 对齐记录 */
function RecordDetail({ a }: { a: Annotation }) {
  const update = useApp(s => s.updateAnnotation)
  const remove = useApp(s => s.removeAnnotation)
  const flyTo = useApp(s => s.flyToAnnotation)
  const [label, setLabel] = useState(a.label)
  const [confirmDel, setConfirmDel] = useState(false)
  const isAlign = a.atype === 'align'
  return (
    <div className="ndetail">
      <div className="nd-head">
        <span className="sw" style={{ background: a.color }} />
        <input className="nd-label" value={label} onChange={e => setLabel(e.target.value)}
          onBlur={() => { const v = label.trim(); if (v && v !== a.label) update(a.id, { label: v }) }} />
        <Badge mono outline>{ATYPE_LABEL[a.atype] ?? a.atype}</Badge>
      </div>
      <div className="nd-row">
        <span className="nd-k">数值</span>
        <span className="mono">{fmtValue(a.value, a.unit, a.atype) || '—'}</span>
      </div>
      {isAlign && <div className="hint">对齐记录：在「对齐」模块左下可重新叠加查看配准效果。</div>}
      <div className="nd-row" style={{ justifyContent: 'flex-end' }}>
        {!isAlign && a.atype !== 'point3d' && a.atype !== 'line3d' && <Button size="xs" icon={<Crosshair size={12} />} onClick={() => flyTo(a.id)}>定位</Button>}
        {confirmDel ? (
          <>
            <Button size="xs" variant="danger" onClick={() => { remove(a.id); setConfirmDel(false) }}>确认删除</Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmDel(false)}>取消</Button>
          </>
        ) : <Button size="xs" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setConfirmDel(true)}>删除</Button>}
      </div>
    </div>
  )
}
