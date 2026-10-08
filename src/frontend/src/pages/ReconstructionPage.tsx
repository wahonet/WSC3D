import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Box, Download, Eye, Layers3, RotateCcw, ScanLine } from 'lucide-react'
import ReconstructionViewer, { type ReconstructionView } from '../components/viewer/ReconstructionViewer'
import ReconstructionDimensions, { dimensionList } from '../components/viewer/ReconstructionDimensions'
import { reconstructionFile, type ReconstructionCase, type ReconstructionSummary, type ReconstructionVariant } from '../lib/reconstruction'
import { useWorkspaceAuth } from '../store/useWorkspaceAuth'
import './reconstruction.css'

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (response.status === 401) { void useWorkspaceAuth.getState().checkSession(); throw new Error('请重新登录工作台') }
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `读取失败（${response.status}）`) }
  return response.json()
}
const groupNames: Record<string, string> = { front: '前石室', left: '左石室', residual: '待定石件' }

function CaseViewer({ data }: { data: ReconstructionCase }) {
  const [variantId, setVariantId] = useState(data.variants?.[0]?.id || '')
  const variant = data.variants?.find(v => v.id === variantId)
  const active = useMemo<ReconstructionCase>(() => variant ? { ...data, parts: data.parts.filter(p => variant.partIds.includes(p.id)), sceneFile: variant.sceneFile, sceneBytes: variant.sceneBytes, previewFile: variant.previewFile } : data, [data, variant])
  const [selected, setSelected] = useState(active.parts[0]?.id || ''), [visible, setVisible] = useState(active.parts.map(p => p.id))
  const [exploded, setExploded] = useState(0), [colored, setColored] = useState(false), [grid, setGrid] = useState(true)
  const [cut, setCut] = useState<number | null>(null), [tab, setTab] = useState('parts')
  const [view, setView] = useState<{ name: ReconstructionView; revision: number }>({ name: 'iso', revision: 0 })
  const [log, setLog] = useState(''), [logError, setLogError] = useState('')
  const part = active.parts.find(p => p.id === selected), unit = data.unitLabel || '工作米'
  const file = (path: string, download = false) => reconstructionFile(data.id, path, download)
  const roofIds = active.parts.filter(p => p.kind === 'roof').map(p => p.id)
  const roofsShown = roofIds.length > 0 && roofIds.every(id => visible.includes(id))
  const show = (name: ReconstructionView) => setView(v => ({ name, revision: v.revision + 1 }))
  const toggle = (id: string) => setVisible(ids => ids.includes(id) ? ids.filter(v => v !== id) : [...ids, id])
  const reset = () => { setVisible(active.parts.map(p => p.id)); setExploded(0); setColored(false); setCut(null); setGrid(true); show('iso') }
  const choose = (v: ReconstructionVariant) => {
    setVariantId(v.id); setVisible(v.partIds); setSelected(v.partIds.includes(selected) ? selected : v.partIds[0]); setExploded(0); setCut(null); show('iso')
  }
  const parameters = variant?.parameters || data.parameters
  const savedViews = variant?.views || [['assembled', '整体配置'], ['interior', '去顶观察'], ['exploded', '构件分解'], ['front', '开口侧正视'], ['plan', '俯视']].map(([id, label]) => ({ path: `outputs/${id}.png`, label }))
  useEffect(() => {
    if (tab !== 'log' || log) return
    const abort = new AbortController(); setLogError('')
    void fetch(file(data.worklogFile), { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error('研究记录暂时无法读取')
      setLog(await r.text())
    }).catch(e => { if (!abort.signal.aborted) setLogError(e.message) })
    return () => abort.abort()
  }, [tab, data, log])
  return <>
    <div className="rc-intro"><div><span className="rc-kicker">建筑复原研究 / {data.version}</span><h1>{data.title}</h1><p>{data.description}</p></div><div className="rc-intro-side"><span className="rc-status">{data.status}</span><small>{data.date} · {data.parts.length} 件模型</small></div></div>
    <div className="rc-assumption"><ScanLine size={17} /><span>{data.scaleNote}</span><button onClick={() => setTab('dimensions')}>尺寸核查<ArrowUpRight size={13} /></button></div>
    {variant && data.variants && <div className="rc-variants">
      <div className="rc-group-tabs" role="group" aria-label="石件组别">{[...new Set(data.variants.map(v => v.group))].map(group => <button key={group} className={variant.group === group ? 'active' : ''} aria-pressed={variant.group === group} onClick={() => choose(data.variants!.find(v => v.group === group)!)}>{groupNames[group] || group}<span>{data.variants!.find(v => v.group === group)!.partIds.length} 件</span></button>)}</div>
      <div className="rc-variant-tabs" role="group" aria-label="拼接方案">{data.variants.filter(v => v.group === variant.group).map(v => <button key={v.id} aria-pressed={v.id === variant.id} className={v.id === variant.id ? 'active' : ''} onClick={() => choose(v)}><strong>{v.title}</strong><small>{v.status}</small></button>)}</div>
      <div className="rc-variant-caption"><p>{variant.description}</p><button onClick={() => setTab('checks')}>比较依据与冲突<ArrowUpRight size={13} /></button></div>
    </div>}
    <div className="rc-workbench">
      <section className="rc-stage" aria-label="复原模型查看">
        <div className="rc-toolbar"><div className="rc-button-group">{([['iso', '轴测'], ['front', '正视'], ['east', '东侧'], ['plan', '俯视']] as const).map(([name, label]) => <button key={name} className={view.name === name ? 'active' : ''} onClick={() => show(name)}>{label}</button>)}</div><button onClick={() => { setVisible(active.parts.filter(p => p.kind === 'wall').map(p => p.id)); setCut(null); show('iso') }}><Eye size={15} />去顶</button>{variant?.group !== 'residual' && data.variants && <button onClick={() => { setVisible(active.parts.filter(p => /小龛|供案|菱纹残石/.test(p.name)).map(p => p.id)); setCut(null); show('iso') }}>小龛</button>}<button onClick={reset} title="恢复当前方案初始显示"><RotateCcw size={15} />重置</button></div>
        <ReconstructionViewer data={active} transforms={variant?.matricesGltf} visible={visible} exploded={exploded} colored={colored} selected={selected} cut={cut} grid={grid} view={view} onSelect={setSelected} />
        <div className="rc-controls"><div className="rc-explode"><Layers3 size={16} /><label htmlFor="rc-explode">构件分解</label><input id="rc-explode" type="range" min="0" max="100" value={Math.round(exploded * 100)} onChange={e => setExploded(Number(e.target.value) / 100)} onPointerUp={() => show(view.name)} onKeyUp={() => show(view.name)} /><output>{Math.round(exploded * 100)}%</output></div>{roofIds.length > 0 && <label><input type="checkbox" checked={roofsShown} onChange={() => setVisible(ids => roofsShown ? ids.filter(id => !roofIds.includes(id)) : [...new Set([...ids, ...roofIds])])} />屋顶</label>}<label><input type="checkbox" checked={colored} onChange={e => setColored(e.target.checked)} />构件分色</label><label><input type="checkbox" checked={grid} onChange={e => setGrid(e.target.checked)} />网格</label></div>
        <div className="rc-cut"><label><input type="checkbox" checked={cut !== null} onChange={e => setCut(e.target.checked ? 1.2 : null)} />水平截取</label><input aria-label="水平截取高度" type="range" min="0.1" max="4.5" step="0.01" disabled={cut === null} value={cut ?? 1.2} onChange={e => setCut(Number(e.target.value))} /><output>{cut === null ? '关闭' : `${cut.toFixed(2)} ${unit}`}</output><small>非实测剖面</small></div>
      </section>
      <aside className="rc-sidebar"><div className="rc-tabs" role="tablist" aria-label="复原研究资料">{[['parts', '构件'], ['sources', '依据'], ['checks', '核查'], ['dimensions', '尺寸'], ['log', '记录']].map(([id, label]) => <button role="tab" aria-selected={tab === id} key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</div><div className="rc-sidebar-body" role="tabpanel">
        {tab === 'parts' && <><div className="rc-panel-heading"><b>{variant ? groupNames[variant.group] : '现存构件'}</b><span>{visible.length} / {active.parts.length} 显示</span></div><div className="rc-part-list">{active.parts.map(p => <div key={p.id} className={`rc-part ${p.id === selected ? 'selected' : ''}`}><input type="checkbox" aria-label={`显示${p.id}`} checked={visible.includes(p.id)} onChange={() => toggle(p.id)} /><button onClick={() => setSelected(p.id)}><i style={{ background: p.color }} /><span><strong>{p.id} <em>{p.name}</em></strong><small>{p.historicalName}</small></span></button></div>)}</div>{part && <div className="rc-part-detail"><h2>{part.id} · {part.name}</h2><p>{part.note}</p><button className="rc-focus" onClick={() => { setVisible(ids => [...new Set([...ids, part.id])]); show('focus') }}>居中查看此件</button><dl><dt>原网格 / 预览三角面</dt><dd>{part.triangles.toLocaleString()} / {(part.previewTriangles ?? part.triangles).toLocaleString()}</dd><dt>原模型轴向跨度 · 单位未核</dt><dd>{dimensionList(part.rawExtents)}</dd>{part.workingExtentsU ? <><dt>本方案比例下的跨度 · U</dt><dd>{dimensionList(part.workingExtentsU)}</dd></> : <><dt>旧登记参照的跨度 · 工作厘米</dt><dd>{dimensionList(part.workingExtentsCm)}</dd></>}<dt>可靠实物尺寸</dt><dd>未标定，不能确定</dd></dl><small>轴向包围跨度不等同于石板厚度，尤其须区分转角石两臂与回折深度。</small><div className="rc-evidence-links">{data.sources.filter(s => part.evidence.includes(s.id)).map(s => <a key={s.id} href={s.url} target="_blank" rel="noreferrer">{s.locator}<ArrowUpRight size={12} /></a>)}</div></div>}{variant && <div className="rc-missing"><h2>本组缺项</h2>{variant.missing.map(s => <p key={s}>{s}</p>)}</div>}</>}
        {tab === 'sources' && <><div className="rc-panel-heading"><b>文献与原页</b><span>{data.sources.length} 条</span></div>{data.sources.map(s => <article className="rc-source" key={s.id}><h2>{s.title}</h2><small>{s.locator}</small><p>{s.claim}</p><div><a href={s.url} target="_blank" rel="noreferrer">{s.url.startsWith('/') ? '文献库阅读' : '来源网站'}<ArrowUpRight size={13} /></a>{s.image && <a href={file(s.image)} target="_blank" rel="noreferrer">查看原页</a>}</div></article>)}<p className="rc-muted">文献配置、模型观察和本项目的试验参数分别记录，不能互相循环证明。</p></>}
        {tab === 'checks' && <>{variant && <><div className="rc-panel-heading"><b>{variant.title}</b></div><div className="rc-metrics">{variant.metrics.map(m => <div key={m.label}><small>{m.label}</small><strong>{m.value} <em>{m.unit}</em></strong></div>)}</div><h2>这一方案改变了什么</h2><ul className="rc-check-list">{variant.changes.map(c => <li key={c}>{c}</li>)}</ul><h2>冲突与局限</h2><ul className="rc-check-list">{variant.conflicts.map(c => <li key={c}>{c}</li>)}</ul></>}<div className="rc-panel-heading"><b>共同核查事项</b></div>{data.findings.map((f, i) => <article className="rc-finding" key={f.title}><span>{String(i + 1).padStart(2, '0')}</span><div><h2>{f.title}</h2><p>{f.text}</p></div></article>)}<dl>{parameters.frontPitchDegrees !== undefined && <><dt>前坡试验角度</dt><dd>{parameters.frontPitchDegrees.toFixed(1)}°</dd></>}{parameters.rearPitchDegrees !== undefined && <><dt>后坡试验角度</dt><dd>{parameters.rearPitchDegrees.toFixed(1)}°</dd></>}</dl><p className="rc-muted">{data.coordinateNote}</p><a className="rc-file-link" href={file('evidence/validation.json', true)}>下载几何检查记录<Download size={13} /></a></>}
        {tab === 'dimensions' && <ReconstructionDimensions data={data} />}
        {tab === 'log' && <><div className="rc-panel-heading"><b>制作记录</b><a href={file(data.worklogFile, true)}><Download size={15} />MD</a></div><p className="rc-muted">独立目录中保存过程、技术路径、软件、全部参数、参考文献与未决项。</p>{logError ? <p role="alert">{logError}</p> : <pre className="rc-worklog">{log || '读取记录…'}</pre>}</>}
      </div><div className="rc-sidebar-footer"><a href={file(variant?.downloadSceneFile || active.sceneFile, true)}><Box size={15} />{variant ? '当前方案 GLB' : '下载 GLB'}<small>{(active.sceneBytes / 1048576).toFixed(1)} MB</small></a>{variant && <a href={file(variant.fullSceneFile, true)}>完整原网格 · {variant.group === 'residual' ? '形制对照' : 'A 方案基线'}<Download size={13} /></a>}<a href={file(data.blendFile, true)}>Blender 工程{variant ? ' · 全部方案' : ''}<Download size={14} /></a></div></aside>
    </div>
    <div className="rc-saved-heading"><h2>{variant?.title || '本次配置'} · 观察视图</h2><span>保留现状缺损与未决接缝</span><a href={file(data.worklogFile, true)}>制作经过与参考文献<Download size={14} /></a></div>
    <div className="rc-saved-views">{savedViews.map(({ path, label }) => <a href={file(path)} target="_blank" rel="noreferrer" key={path}><img loading="lazy" src={file(path)} alt={label} /><span>{label}<ArrowUpRight size={14} /></span></a>)}</div>
    {data.variants && <div className="rc-comparison"><h2>方案比较</h2><p>轮廓残差采用未标定的 U；只比较同组 A/B 的上下墙石前缘。它不是精度、真实性或结构安全评分。</p><div className="rc-table-scroll"><table><thead><tr><th>方案</th><th>模型数</th><th>叠砌前缘 RMS</th><th>判断</th></tr></thead><tbody>{data.variants.map(v => <tr key={v.id} className={v.id === variantId ? 'selected' : ''}><td><button onClick={() => { choose(v); setTab('checks') }}>{v.title}</button></td><td>{v.partIds.length}</td><td>{v.metrics.find(m => m.label.includes('RMS'))?.value || '不适用'}</td><td>{v.status}</td></tr>)}</tbody></table></div>{data.coverage && <p className="rc-muted">本轮范围 {data.coverage.requested} 件：{data.coverage.models} 件有模型，{data.coverage.missing.map(m => `${m.id}（${m.name}）`).join('、')} 缺模。R01 五石保留为独立历史版本。</p>}</div>}
  </>
}

export default function ReconstructionPage() {
  const [cases, setCases] = useState<ReconstructionSummary[]>([]), [caseId, setCaseId] = useState('')
  const [data, setData] = useState<ReconstructionCase | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  useEffect(() => {
    const abort = new AbortController()
    void readJson<{ cases: ReconstructionSummary[]; errors: { id: string; message: string }[] }>('/api/reconstruction', abort.signal).then(r => {
      const ordered = r.cases.sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0) || b.date.localeCompare(a.date))
      setCases(ordered); setCaseId(ordered[0]?.id || ''); setLoading(false)
      if (r.errors.length) setError(r.errors.map(e => `${e.id}：${e.message}`).join('；'))
    }).catch(e => { if (!abort.signal.aborted) { setError(e.message); setLoading(false) } })
    return () => abort.abort()
  }, [])
  useEffect(() => {
    if (!caseId) return
    const abort = new AbortController(); setData(null); setLoading(true)
    void readJson<ReconstructionCase>(`/api/reconstruction/${encodeURIComponent(caseId)}`, abort.signal).then(r => { setData(r); setLoading(false) }).catch(e => { if (!abort.signal.aborted) { setError(e.message); setLoading(false) } })
    return () => abort.abort()
  }, [caseId])
  return <div className="rc-page">
    {cases.length > 1 && <label className="rc-case-picker">复原项目<select value={caseId} onChange={e => { setError(''); setCaseId(e.target.value) }}>{cases.map(c => <option key={c.id} value={c.id}>{c.title} · {c.version}</option>)}</select></label>}
    {error && <div className="rc-error" role="alert">{error}<button onClick={() => location.reload()}>重新载入</button></div>}
    {loading && <div className="rc-empty" role="status">读取复原项目…</div>}
    {!loading && !data && !error && <div className="rc-empty"><Box size={32} /><h1>三维复原</h1><p>尚未保存复原成果。研究项目将从独立工作目录载入。</p></div>}
    {data && <CaseViewer key={data.id} data={data} />}
  </div>
}
