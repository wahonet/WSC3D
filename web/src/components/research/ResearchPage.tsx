import { useCallback, useEffect, useMemo, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ArrowLeft, Crosshair, Link2, Save, Unlink } from 'lucide-react'
import { getStone, listStones, patchAnnotation, patchLayer, patchStone, stoneAnnotations } from '../../api'
import { ATYPE_LABEL, COLORS } from '../../lib/constants'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { Annotation, StoneInfo, StoneNode } from '../../types'
import { Badge, Button, Chip, Empty, Field } from '../ui'
import ResearchViewer from './ResearchViewer'
import TextCard, { buildSources, type PendingSel } from './TextCard'

type Fields = { dims_text: string; era: string; material: string; carving: string; location: string }
const FIELD_LABELS: [keyof Fields, string][] = [
  ['dims_text', '尺寸'], ['era', '年代'], ['material', '材质'], ['carving', '刻法'], ['location', '位置'],
]

export default function ResearchPage({ stoneId }: { stoneId: number }) {
  const setPage = useApp(s => s.setPage)
  const layout = useDefaultLayout({ id: 'stonelab.layout.research', storage: localStorage })

  const [stone, setStone] = useState<StoneNode | null>(null)
  const [info, setInfo] = useState<StoneInfo | null>(null)
  const [allAnnos, setAllAnnos] = useState<Annotation[]>([])
  const [curAssetId, setCurAssetId] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [focus, setFocus] = useState(0)
  const [fields, setFields] = useState<Fields>({ dims_text: '', era: '', material: '', carving: '', location: '' })
  const [fieldsDirty, setFieldsDirty] = useState(false)
  const [pending, setPending] = useState<PendingSel | null>(null)

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
      const master = eligible.find(a => a.is_master)
      setCurAssetId((master ?? eligible[0])?.id ?? null)
    }).catch(toast.error)
  }, [reload])

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
  const curAnnos = useMemo(() => allAnnos.filter(a => a.asset_id === curAssetId && a.atype !== 'align'), [allAnnos, curAssetId])
  const links = useMemo(() => allAnnos.filter(a => a.desc_text && a.desc_start != null), [allAnnos])
  const selected = allAnnos.find(a => a.id === selectedId) ?? null
  const sources = useMemo(() => (info ? buildSources(info) : []), [info])
  const sourceTitle = (key: string) => sources.find(s => s.key === key)?.title ?? key

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

  const selectAnno = (id: number | null) => {
    setSelectedId(id)
    if (id != null) {
      const a = allAnnos.find(x => x.id === id)
      if (a && a.asset_id !== curAssetId && eligibleAssets.some(e => e.id === a.asset_id)) setCurAssetId(a.asset_id)
    }
  }

  return (
    <div className="research">
      <div className="research-body">
        <Group orientation="horizontal" id="research" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
          <Panel id="rviewer" minSize="35%">
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
                ? <ResearchViewer asset={curAsset} annos={curAnnos} selectedId={selectedId} onSelect={selectAnno} focus={focus} />
                : <Empty title="该石头暂无可显示的已对齐图层" />}
            </div>
          </Panel>
          <Separator className="sep-h" />
          <Panel id="rside" defaultSize="34%" minSize="320px" maxSize="55%">
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

              <section className="rcard">
                <div className="rcard-h">
                  标注<span className="grow" /><span className="count hint" style={{ textTransform: 'none', letterSpacing: 0 }}>{curAnnos.length} 条</span>
                </div>
                {curAnnos.length === 0 && <Empty>当前图层无标注。回工作台用「标注 / 分割」创建。</Empty>}
                <div className="ra-list">
                  {curAnnos.map(a => (
                    <div key={a.id} className={`ra-row${a.id === selectedId ? ' on' : ''}`}
                      onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}>
                      <span className="sw" style={{ background: a.desc_text ? COLORS.linked : a.color }} />
                      <span className="lb">{a.label}</span>
                      {a.desc_text && <Badge tone="amber"><Link2 size={10} />已关联</Badge>}
                      <Badge mono outline>{ATYPE_LABEL[a.atype] ?? a.atype}</Badge>
                    </div>
                  ))}
                </div>

                {selected && (
                  <div className="ra-editor">
                    <div className="rrow" style={{ marginTop: 0 }}>
                      <Field label="名称">
                        <input className="input sm" defaultValue={selected.label} key={`lb${selected.id}`} style={{ width: 220 }}
                          onBlur={e => { const v = e.target.value.trim(); if (v && v !== selected.label) saveLabel(selected.id, v) }}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                      </Field>
                      <span style={{ flex: 1 }} />
                      <Button size="xs" icon={<Crosshair size={12} />} onClick={() => setFocus(f => f + 1)} title="视图定位到该标注">定位</Button>
                    </div>
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
                          placeholder="手动填写内容，或在上方简介中拖选文字后点「关联」"
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
        </Group>
      </div>
    </div>
  )
}
