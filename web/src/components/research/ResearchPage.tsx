import { useCallback, useEffect, useMemo, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ArrowLeft, Crosshair, Link2, Save, Search, Unlink } from 'lucide-react'
import {
  getProjected, getStone, listStones, patchAnnotation, patchLayer, patchStone, stoneAnnotations,
} from '../../api'
import { ATYPE_LABEL, COLORS } from '../../lib/constants'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { Annotation, ProjectedAnnotation, StoneInfo, StoneNode } from '../../types'
import { Badge, Button, Chip, Empty, Field } from '../ui'
import ResearchViewer from './ResearchViewer'
import TextCard, { buildSources, type PendingSel } from './TextCard'

type Fields = { dims_text: string; era: string; material: string; carving: string; location: string }
const FIELD_LABELS: [keyof Fields, string][] = [
  ['dims_text', '尺寸'], ['era', '年代'], ['material', '材质'], ['carving', '刻法'], ['location', '位置'],
]
type ListFilter = 'all' | 'linked' | 'unlinked'

/** 当前图层上可见的一条标注：本图层自有，或从其他已入链图层投影而来 */
interface VisibleAnno { a: Annotation; projectedFrom: string | null }

export default function ResearchPage({ stoneId, initialAssetId }: { stoneId: number; initialAssetId?: number | null }) {
  const setPage = useApp(s => s.setPage)
  const layout = useDefaultLayout({ id: 'stonelab.layout.research3', storage: localStorage })

  const [stone, setStone] = useState<StoneNode | null>(null)
  const [info, setInfo] = useState<StoneInfo | null>(null)
  const [allAnnos, setAllAnnos] = useState<Annotation[]>([])
  const [curAssetId, setCurAssetId] = useState<number | null>(null)
  const [projected, setProjected] = useState<ProjectedAnnotation[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [focus, setFocus] = useState(0)
  const [fields, setFields] = useState<Fields>({ dims_text: '', era: '', material: '', carving: '', location: '' })
  const [fieldsDirty, setFieldsDirty] = useState(false)
  const [pending, setPending] = useState<PendingSel | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ListFilter>('all')

  const reload = useCallback(async () => {
    const [stones, inf, ann] = await Promise.all([listStones(), getStone(stoneId), stoneAnnotations(stoneId)])
    const st = stones.find(s => s.id === stoneId) ?? null
    setStone(st)
    setInfo(inf)
    setAllAnnos(ann)
    setFields({ dims_text: inf.dims_text, era: inf.era, material: inf.material, carving: inf.carving, location: inf.location })
    setFieldsDirty(false)
    return st
  }, [stoneId])

  useEffect(() => {
    reload().then(st => {
      if (!st) return
      const eligible = st.groups.filter(g => g.key !== 'model').flatMap(g => g.assets).filter(a => a.is_master || a.in_frame)
      // 从工作台带过来的当前图若已入链，就直接在该图层上打开；否则回到主图
      const fromWork = eligible.find(a => a.id === initialAssetId)
      const master = eligible.find(a => a.is_master)
      setCurAssetId((fromWork ?? master ?? eligible[0])?.id ?? null)
    }).catch(toast.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload])

  // 图层切换或标注变化后，拉取其他已入链图层（主图等）到本图层的投影
  useEffect(() => {
    if (curAssetId == null) { setProjected([]); return }
    let alive = true
    getProjected(curAssetId)
      .then(r => { if (alive) setProjected(r.ok ? r.items : []) })
      .catch(() => { if (alive) setProjected([]) })
    return () => { alive = false }
  }, [curAssetId, allAnnos])

  // 离开研究模块时同步工作台数据（元数据/标注可能已修改）
  useEffect(() => () => {
    const s = useApp.getState()
    s.loadStones().catch(() => undefined)
    s.refreshStoneInfo().catch(() => undefined)
    s.refreshAnnos().catch(() => undefined)
    s.loadStats().catch(() => undefined)
  }, [])

  const eligibleAssets = useMemo(() => stone
    ? stone.groups.filter(g => g.key !== 'model').flatMap(g => g.assets).filter(a => a.is_master || a.in_frame)
    : [], [stone])
  const curAsset = eligibleAssets.find(a => a.id === curAssetId) ?? null
  const byId = useMemo(() => new Map(allAnnos.map(a => [a.id, a])), [allAnnos])
  const ownAnnos = useMemo(
    () => allAnnos.filter(a => a.asset_id === curAssetId && a.atype !== 'align'), [allAnnos, curAssetId])
  const visible: VisibleAnno[] = useMemo(() => [
    ...ownAnnos.map(a => ({ a, projectedFrom: null })),
    ...projected.flatMap(p => {
      const a = byId.get(p.id)
      return a ? [{ a, projectedFrom: p.source_filename }] : []
    }),
  ], [ownAnnos, projected, byId])
  const visibleIds = useMemo(() => new Set(visible.map(v => v.a.id)), [visible])
  const links = useMemo(() => allAnnos.filter(a => a.desc_text && a.desc_start != null), [allAnnos])
  const linkedIds = useMemo(() => new Set(links.map(a => a.id)), [links])
  const selected = selectedId != null ? byId.get(selectedId) ?? null : null
  const sources = useMemo(() => (info ? buildSources(info) : []), [info])
  const sourceTitle = (key: string) => sources.find(s => s.key === key)?.title ?? key

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return visible.filter(({ a }) => {
      if (filter === 'linked' && !a.desc_text) return false
      if (filter === 'unlinked' && a.desc_text) return false
      if (q && !a.label.toLowerCase().includes(q) && !(a.note || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [visible, query, filter])

  /* ---------- 元数据字段 ---------- */
  const setF = (k: keyof Fields, v: string) => { setFields(f => ({ ...f, [k]: v })); setFieldsDirty(true) }
  const saveFields = async () => {
    try {
      setInfo(await patchStone(stoneId, fields))
      setFieldsDirty(false)
      toast.ok('石头信息已保存')
    } catch (e) { toast.error(e) }
  }

  /* ---------- 文本保存（受锁定保护） ---------- */
  const saveText = async (sourceKey: string, text: string) => {
    try {
      if (sourceKey === 'description') await patchStone(stoneId, { description: text })
      else await patchLayer(stoneId, Number(sourceKey.split(':')[1]), text)
      await reload()
      toast.ok('已保存')
      return true
    } catch (e) { toast.error(e); return false }
  }

  /* ---------- 关联 / 取消关联 ---------- */
  const doLink = async () => {
    if (!selected || !pending) return
    try {
      await patchAnnotation(selected.id, {
        desc_source: pending.source, desc_start: pending.start, desc_end: pending.end, desc_text: pending.text,
      })
      setPending(null)
      window.getSelection()?.removeAllRanges()
      await reload()
      toast.ok(`已将文字关联到标注「${selected.label}」`)
    } catch (e) { toast.error(e) }
  }
  const doUnlink = async (id: number) => {
    try {
      await patchAnnotation(id, { clear_link: true })
      await reload()
      toast.ok('已取消关联，文字恢复可编辑')
    } catch (e) { toast.error(e) }
  }
  const saveLabel = async (id: number, label: string) => {
    try { await patchAnnotation(id, { label }); await reload() } catch (e) { toast.error(e) }
  }
  const saveNote = async (id: number, note: string) => {
    try { await patchAnnotation(id, { note }); await reload(); toast.ok('标注内容已保存') } catch (e) { toast.error(e) }
  }

  /** 选中标注；若它在当前图层上不可见（既非自有也非投影），切到它所属图层 */
  const selectAnno = (id: number | null) => {
    setSelectedId(id)
    if (id == null || visibleIds.has(id)) return
    const a = byId.get(id)
    if (a && a.asset_id !== curAssetId && eligibleAssets.some(e => e.id === a.asset_id)) setCurAssetId(a.asset_id)
  }
  const selectedVisible = selected ? visible.find(v => v.a.id === selected.id) ?? null : null

  return (
    <div className="research">
      <div className="research-body">
        <Group orientation="horizontal" id="research3" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
          {/* ---------------- 左：标注栏 ---------------- */}
          <Panel id="rannos" defaultSize="22%" minSize="260px" maxSize="40%">
            <div className="rcol">
              <section className="rcard fill">
                <div className="rcard-h">
                  标注<span className="grow" />
                  <span className="hint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    {shown.length === visible.length ? `${visible.length} 条` : `${shown.length} / ${visible.length} 条`}
                  </span>
                </div>
                <div className="tree-search" style={{ padding: '0 0 8px' }}>
                  <div className="wrap">
                    <Search size={13} />
                    <input className="input sm" placeholder="按名称 / 内容筛选" value={query} onChange={e => setQuery(e.target.value)} />
                  </div>
                </div>
                <div className="chips" style={{ marginBottom: 8 }}>
                  {([['all', '全部'], ['linked', '已关联'], ['unlinked', '未关联']] as [ListFilter, string][]).map(([k, lb]) => (
                    <Chip key={k} size="sm" on={filter === k} onClick={() => setFilter(k)}>{lb}</Chip>
                  ))}
                </div>
                {visible.length === 0 && <Empty>当前图层无标注。回工作台用「标注 / 分割」创建，或先把本图与主图对齐以显示主图标注的投影。</Empty>}
                <div className="ra-list grow">
                  {shown.map(({ a, projectedFrom }) => (
                    <div key={a.id} className={`ra-row${a.id === selectedId ? ' on' : ''}`}
                      onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}
                      title={projectedFrom ? `投影自 ${projectedFrom}` : undefined}>
                      <span className="sw" style={{ background: a.desc_text ? COLORS.linked : a.color }} />
                      <span className="lb">{a.label}</span>
                      {projectedFrom && <Badge tone="violet" title={`投影自 ${projectedFrom}`}>投影</Badge>}
                      {a.desc_text && <Badge tone="amber"><Link2 size={10} /></Badge>}
                      <Badge mono outline>{ATYPE_LABEL[a.atype] ?? a.atype}</Badge>
                    </div>
                  ))}
                </div>

                {selected && (
                  <div className="ra-editor">
                    <div className="rrow" style={{ marginTop: 0 }}>
                      <Field label="名称">
                        <input className="input sm" defaultValue={selected.label} key={`lb${selected.id}`}
                          onBlur={e => { const v = e.target.value.trim(); if (v && v !== selected.label) saveLabel(selected.id, v) }}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                      </Field>
                      <span style={{ flex: 1 }} />
                      <Button size="xs" icon={<Crosshair size={12} />} onClick={() => setFocus(f => f + 1)} title="视图定位到该标注">定位</Button>
                    </div>
                    {selectedVisible?.projectedFrom && (
                      <div className="hint">此标注属于「{selectedVisible.projectedFrom}」，在本图层以投影显示；图文关联对它同样生效。</div>
                    )}
                    <div className="hint" style={{ fontWeight: 600 }}>标注内容</div>
                    {selected.desc_text ? (
                      <>
                        <div className="ra-linkedtext">{selected.desc_text}</div>
                        <div className="rrow" style={{ marginTop: 4 }}>
                          <span className="hint" style={{ flex: 1 }}>来自「{sourceTitle(selected.desc_source)}」的关联文字（锁定）</span>
                          <Button size="xs" variant="danger" icon={<Unlink size={12} />} onClick={() => doUnlink(selected.id)}>取消关联</Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <textarea className="textarea" key={`nt${selected.id}`} defaultValue={selected.note}
                          placeholder="手动填写内容，或在右侧简介中拖选文字后点「关联」"
                          onBlur={e => { if (e.target.value !== selected.note) saveNote(selected.id, e.target.value) }} />
                        {pending && (
                          <Button size="sm" variant="primary" icon={<Link2 size={13} />} onClick={doLink}>
                            关联选中文字（{pending.text.length} 字）
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </section>
            </div>
          </Panel>
          <Separator className="sep-h" />

          {/* ---------------- 中：图像 ---------------- */}
          <Panel id="rviewer" minSize="30%">
            <div className="center">
              <div className="rv-bar">
                <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => setPage('work')}>返回工作台</Button>
                <span className="muted">图层</span>
                {eligibleAssets.map(a => (
                  <Chip key={a.id} on={a.id === curAssetId} onClick={() => setCurAssetId(a.id)} title={a.filename}>
                    {a.is_master ? '主图 · ' : ''}{a.filename}
                  </Chip>
                ))}
                {eligibleAssets.length <= 1 && (
                  <span className="hint">（其他图层需先在工作台与主图对齐后才会出现在这里）</span>
                )}
              </div>
              {curAsset
                ? <ResearchViewer asset={curAsset} annos={ownAnnos} projected={projected} linkedIds={linkedIds}
                    selectedId={selectedId} onSelect={selectAnno} focus={focus} />
                : <Empty title="该石头暂无可显示的已对齐图层" />}
            </div>
          </Panel>
          <Separator className="sep-h" />

          {/* ---------------- 右：石头信息 + 简介 ---------------- */}
          <Panel id="rside" defaultSize="30%" minSize="300px" maxSize="50%">
            <div className="rside">
              <section className="rcard">
                <div className="rcard-h">
                  石头信息
                  <span className="grow" />
                  {info && <span className="hint" style={{ textTransform: 'none', letterSpacing: 0 }}>{info.name} · {info.code}</span>}
                </div>
                <div className="rfields">
                  {FIELD_LABELS.map(([k, lb]) => (
                    <Field key={k} label={lb}>
                      <input className="input sm" value={fields[k]} onChange={e => setF(k, e.target.value)} />
                    </Field>
                  ))}
                </div>
                {fieldsDirty && (
                  <div className="rrow">
                    <Button size="sm" variant="primary" icon={<Save size={13} />} onClick={saveFields}>保存信息</Button>
                    <Button size="sm" variant="ghost" onClick={() => reload()}>放弃修改</Button>
                  </div>
                )}
              </section>

              <TextCard sources={sources} links={links} selectedId={selectedId} selectedLabel={selected?.label ?? null}
                pending={pending} onPending={setPending} onSelectAnno={selectAnno}
                onSave={saveText} onLink={doLink} onError={toast.warn} />
            </div>
          </Panel>
        </Group>
      </div>
    </div>
  )
}
