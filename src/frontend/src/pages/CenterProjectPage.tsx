import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, DoorOpen, Info, LogOut, RotateCcw } from 'lucide-react'
import { createCenterStage, type CenterStage, type Hall } from '../center/centerStage'
import { DEFAULT_LAYERS, HVAC, PLUMBING, type CenterLayers, type CenterMode, type StoreyLevel, type SystemKey } from '../center/centerModel'
import zonesData from '../center/centerZones.json'
import project from '../center/centerProject.json'
import redline from '../center/centerRedline.json'
import exhibition from '../center/centerExhibition.json'
import CreativeLinks from '../components/CreativeLinks'
import '../center/centerProject.css'

const MODES: [CenterMode, string, string][] = [
  ['all', '整体', '完整的传承中心、武氏祠与周边环境（同院落全景布局）'],
  ['noroof', '去除屋顶', '去掉屋顶、檐口和斗栱，俯看二层与单层部分的内部'],
  ['F2', '只显示二层', '二层 +5.40'],
  ['F1', '只显示一层', '一层 ±0.00（含文物管理用房）'],
  ['B1', '只显示负一', '负一层 −4.80，揭开地面查看地下室'],
  ['explode', '爆炸', '各层分开抬升，查看上下层对应关系'],
]
const LAYERS: [keyof CenterLayers, string, string][] = [
  ['zones', '功能分区', '按楼层色系与功能区着色（负一层冷色、一层暖色、二层紫色）'],
  ['exhibit', '展陈', '按展陈设计文件（9.18 改）布置的各展厅装修与展项'],
  ['structure', '结构', '结构施工图的柱、梁与地下室外墙'],
  ['hvac', '暖通', '送风、排风、排烟风管与空调室内机'],
  ['plumbing', '给排水', '给水、排水、雨水与消防喷淋管'],
  ['landscape', '景观', '用地红线内景观施工图的绿地、铺装、灌木与乔木树种；关闭时显示总图示意树木'],
  ['shrine', '武氏祠', '武氏祠院落白模（外形示意）'],
  ['redline', '用地红线', `传承中心用地红线（景观底图界址点），约 ${(redline.areaM2 / 1e4).toFixed(2)} 公顷`],
]
const SYSTEM_LABEL: Record<SystemKey, [string, string]> = {
  supply: ['空调送风管', '#339af0'], exhaust: ['排风管', '#94d82d'], smoke: ['排烟及正压送风管', '#f76707'], ac: ['空调室内机及冷媒管', '#15aabf'],
  water: ['给水管', '#2f9e44'], drain: ['排水管', '#a0522d'], rain: ['雨水管', '#5c7cfa'], sprinkler: ['消防喷淋管', '#e03131'],
}
const STOREYS: StoreyLevel[] = ['F2', 'F1', 'B1']
type Zone = typeof zonesData.levels.B1.zones[number] & { building?: string }
interface Entry { key: string; name: string; color: string; area: number; ids: string[]; first: Zone }

/** 同一层中同名同色的房间合并为一条图例，按功能分组。 */
function legendOf(level: StoreyLevel) {
  const groups = new Map<string, Entry[]>()
  for (const zone of zonesData.levels[level].zones as Zone[]) {
    const list = groups.get(zone.function) ?? []
    const key = zone.name + zone.color
    const entry = list.find(e => e.key === key)
    if (entry) { entry.area += zone.area; entry.ids.push(zone.id) }
    else list.push({ key, name: zone.name, color: zone.color, area: zone.area, ids: [zone.id], first: zone })
    groups.set(zone.function, list)
  }
  return Object.keys(zonesData.functions).filter(f => groups.has(f))
    .map(f => ({ function: f, label: zonesData.functions[f as keyof typeof zonesData.functions], entries: groups.get(f)! }))
}
const findZone = (id: string) => {
  for (const level of STOREYS) {
    const zone = (zonesData.levels[level].zones as Zone[]).find(z => z.id === id)
    if (zone) return { level, zone }
  }
  return null
}
const familyColor = (level: StoreyLevel) => zonesData.levels[level].zones[0]?.color ?? '#999'

const HALLS = exhibition.halls as Hall[]
const ROUTE = exhibition.route.map(id => HALLS.find(h => h.id === id)!)
const HALL_GROUPS: [string, Hall[]][] = [
  ['主展线', ROUTE],
  ['剧场与专题展厅', HALLS.filter(h => !exhibition.route.includes(h.id))],
]
const hallOfZone = (zone: string) => HALLS.find(h => h.zones.includes(zone))
const pagesText = (pages: number[]) => pages.length > 1 && pages.every((p, i) => !i || p === pages[i - 1] + 1)
  ? `${pages[0]}–${pages[pages.length - 1]}` : pages.join('、')

export default function CenterProjectPage({ active }: { active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<CenterStage | null>(null)
  const [status, setStatus] = useState<{ state: 'loading' | 'ready' | 'error'; loaded: number; total: number }>({ state: 'loading', loaded: 0, total: 4 })
  const [mode, setModeState] = useState<CenterMode>('all')
  const [layers, setLayersState] = useState<CenterLayers>(DEFAULT_LAYERS)
  const layersRef = useRef(layers)
  const [selected, setSelected] = useState<string | null>(null)
  const [legendOpen, setLegendOpen] = useState(() => window.innerWidth > 900)
  const [infoOpen, setInfoOpen] = useState(false)
  const [hall, setHall] = useState<Hall | null>(null)
  const [hallInfoOpen, setHallInfoOpen] = useState(() => window.innerWidth > 900 && window.innerHeight > 700)
  const [ceilings, setCeilings] = useState(true)

  useEffect(() => {
    const stage = createCenterStage(hostRef.current!, {
      onProgress: (loaded, total) => setStatus(s => ({ ...s, loaded, total })),
      onReady: () => setStatus(s => ({ ...s, state: 'ready' })),
      onError: error => { console.error('传承中心模型加载失败', error); setStatus(s => ({ ...s, state: 'error' })) },
      onPick: zone => setSelected(zone),
    })
    stageRef.current = stage
    return () => { stage.dispose(); stageRef.current = null }
  }, [])
  useEffect(() => { stageRef.current?.setActive(active) }, [active])
  useEffect(() => { stageRef.current?.select(selected) }, [selected])
  useEffect(() => {
    if (!hall || !active) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') leaveHall() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function enterHall(next: Hall) {
    if (!layersRef.current.exhibit) applyLayers({ ...layersRef.current, exhibit: true })
    setHall(next)
    setModeState(next.level as StoreyLevel)
    setSelected(null)
    stageRef.current?.enterHall(next.id)
    if (window.innerWidth <= 900) setLegendOpen(false)
  }
  function leaveHall() {
    setHall(null)
    stageRef.current?.leaveHall()
  }
  function toggleCeilings() {
    setCeilings(!ceilings)
    stageRef.current?.setCeilings(!ceilings)
  }
  function setMode(next: CenterMode) {
    setHall(null)
    setModeState(next)
    stageRef.current?.setMode(next)
    const picked = selected && findZone(selected)
    if (picked && next !== 'explode' && next !== 'noroof' && next !== picked.level) setSelected(null)
  }
  function applyLayers(next: CenterLayers) {
    layersRef.current = next
    setLayersState(next)
    stageRef.current?.setLayers(next)
  }
  function toggleLayer(key: keyof CenterLayers) {
    const next = { ...layersRef.current, [key]: !layersRef.current[key] }
    applyLayers(next)
    if (key === 'exhibit' && !next.exhibit && hall) leaveHall()
    // zones, halls and services sit inside the closed building: open the roof so the switch shows something
    if (next[key] && mode === 'all' && ['zones', 'exhibit', 'structure', 'hvac', 'plumbing'].includes(key)) setMode('noroof')
  }
  function focus(entry: Entry, level: StoreyLevel) {
    const switching = hall !== null || (mode !== level && mode !== 'explode')
    if (switching) setMode(level)
    setSelected(entry.ids[0])
    if (window.innerWidth <= 900) setLegendOpen(false)
    window.setTimeout(() => stageRef.current?.focusZone(level, entry.first.p[0], entry.first.p[1]), switching ? 1150 : 0)
  }

  const visibleStoreys = mode === 'explode' || mode === 'noroof' ? STOREYS : STOREYS.filter(l => l === mode)
  const legends = useMemo(() => Object.fromEntries(STOREYS.map(l => [l, legendOf(l)])) as Record<StoreyLevel, ReturnType<typeof legendOf>>, [])
  const systems = [...(layers.hvac ? HVAC : []), ...(layers.plumbing ? PLUMBING : [])]
  const picked = selected ? findZone(selected) : null
  const pickedHall = picked && layers.exhibit ? hallOfZone(picked.zone.id) : undefined
  const step = hall ? ROUTE.indexOf(hall) : -1
  const showHalls = layers.exhibit && mode !== 'all'
  const totalArea = project.areas.reduce((sum, a) => sum + a.value, 0) + 89.9

  return (
    <div className="center-page">
      <div className="center-stage" ref={hostRef} />
      <div className="center-toolbar" role="toolbar" aria-label="传承中心分层查看">
        <div className="center-modes" role="group" aria-label="视图">
          {MODES.map(([key, label, title]) => [
            <button key={key} className={mode === key ? 'on' : ''} aria-pressed={mode === key} title={title}
              disabled={status.state !== 'ready'} onClick={() => setMode(key)}>{label}</button>,
            key === 'noroof' && (
              <button key="ceilings" className={ceilings ? '' : 'on'} aria-pressed={!ceilings}
                title={hall ? '去掉展厅吊顶，便于转动视角、从上方看进展厅；吊挂的桁架、灯具等保留' : '进入展厅后可用：去掉展厅吊顶'}
                disabled={status.state !== 'ready' || !hall} onClick={toggleCeilings}>去除天花板</button>
            ),
          ])}
          <span className="sep" />
          <button title="回到当前视图的默认视角" aria-label="重置视角" onClick={() => stageRef.current?.resetView()}><RotateCcw size={15} /></button>
        </div>
        <div className="center-layer-switches" role="group" aria-label="图层">
          {LAYERS.map(([key, label, title]) => (
            <button key={key} className={layers[key] ? 'on' : ''} role="switch" aria-checked={layers[key]} title={title}
              disabled={status.state !== 'ready'} onClick={() => toggleLayer(key)}>
              <span className="switch-dot" aria-hidden="true" />{label}</button>
          ))}
        </div>
      </div>

      <aside className={`center-info${infoOpen ? ' open' : ''}`} aria-label="项目信息" hidden={hall !== null}>
        <button className="center-info-head" onClick={() => setInfoOpen(!infoOpen)} aria-expanded={infoOpen}>
          <Info size={16} /><span><strong>{project.title}</strong><small>{project.subtitle}</small></span>
          {infoOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {infoOpen && <div className="center-info-body">
          <dl className="center-areas">
            {project.areas.map(a => <div key={a.label}><dt>{a.label}</dt><dd>{a.value.toLocaleString('zh-CN', { minimumFractionDigits: 2 })} m²{a.note && <small>{a.note}</small>}</dd></div>)}
            <div className="total"><dt>总建筑面积</dt><dd>{totalArea.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} m²</dd></div>
          </dl>
          <h3>模型依据</h3>
          <ul className="center-drawings">
            {project.drawings.map(d => <li key={d.discipline}><b>{d.discipline}</b><span>{d.use}</span><small>{d.file}</small></li>)}
          </ul>
          <p className="center-note">建筑与分区按施工图平面生成；展厅装修与展项按展陈设计文件的效果图对位布置，尺度与材质为示意，其余房间不含装修与家具；机电管线按平面位置挂于各层梁底，标高为示意。武氏祠仅作外形白模；周边道路、农田与村舍沿用院落全景的周边环境。</p>
        </div>}
      </aside>

      {(layers.zones && mode !== 'all' || systems.length > 0 || showHalls) && (
        <aside className={`center-legend${legendOpen ? '' : ' collapsed'}`} aria-label="图例">
          <button className="center-legend-head" onClick={() => setLegendOpen(!legendOpen)} aria-expanded={legendOpen}>
            {hall ? '展厅导览' : '图例'}{legendOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          {legendOpen && <div className="center-legend-body">
            {showHalls && <section className="center-halls">
              <h3><DoorOpen size={14} />展厅导览<small>展陈设计 9.18 改</small></h3>
              {HALL_GROUPS.map(([title, list]) => (
                <div key={title} className="center-legend-group">
                  <h4>{title}</h4>
                  <ol>
                    {list.map(h => (
                      <li key={h.id}>
                        <button className={hall?.id === h.id ? 'on' : ''} onClick={() => enterHall(h)} title={`进入${h.name}`}
                          onMouseEnter={() => stageRef.current?.highlight(h.zones)} onMouseLeave={() => stageRef.current?.highlight([])}>
                          <span>{h.name}<em>{h.chapter.split(' · ')[0]}</em></span>
                          <small>{zonesData.levels[h.level as StoreyLevel].title}</small>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </section>}
            {layers.zones && mode !== 'all' && !hall && visibleStoreys.map(level => (
              <section key={level}>
                <h3><i style={{ background: familyColor(level) }} />{zonesData.levels[level].title}</h3>
                {legends[level].map(group => (
                  <div key={group.function} className="center-legend-group">
                    <h4>{group.label}</h4>
                    <ul>
                      {group.entries.map(entry => (
                        <li key={entry.key}>
                          <button className={entry.ids.includes(selected ?? '') ? 'on' : ''}
                            onMouseEnter={() => stageRef.current?.highlight(entry.ids)} onMouseLeave={() => stageRef.current?.highlight([])}
                            onFocus={() => stageRef.current?.highlight(entry.ids)} onBlur={() => stageRef.current?.highlight([])}
                            onClick={() => focus(entry, level)} title={`定位到${entry.name}`}>
                            <i style={{ background: entry.color }} /><span>{entry.name}{entry.ids.length > 1 && <em>×{entry.ids.length}</em>}</span>
                            <small>{entry.area} m²</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ))}
            {systems.length > 0 && <section>
              <h3>机电管线</h3>
              <ul className="center-systems">
                {systems.map(s => <li key={s}><i style={{ background: SYSTEM_LABEL[s][1] }} />{SYSTEM_LABEL[s][0]}</li>)}
              </ul>
            </section>}
          </div>}
        </aside>
      )}

      {picked && !hall && (
        <div className="center-card" role="status">
          <i style={{ background: picked.zone.color }} />
          <div>
            <strong>{picked.zone.name}</strong>
            <span>{zonesData.levels[picked.level].title} · {zonesData.functions[picked.zone.function as keyof typeof zonesData.functions]}
              {picked.zone.building ? ` · ${picked.zone.building}` : ''} · 约 {picked.zone.area} m²</span>
          </div>
          {pickedHall && <button className="enter" onClick={() => enterHall(pickedHall)}><DoorOpen size={15} />进入{pickedHall.name}</button>}
          <button aria-label="关闭房间信息" onClick={() => setSelected(null)}>✕</button>
        </div>
      )}

      {hall && (
        <section className={`center-card center-hall-card${hallInfoOpen ? '' : ' collapsed'}`} aria-label="展厅说明">
          <div className="center-hall-heading">
            <strong aria-live="polite">{hall.name}</strong>
            <button className="center-hall-toggle" onClick={() => setHallInfoOpen(open => !open)}
              aria-expanded={hallInfoOpen} aria-controls="center-hall-details">
              {hallInfoOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              {hallInfoOpen ? '收起说明' : '展开说明'}
            </button>
          </div>
          <div id="center-hall-details" className="center-hall-details" hidden={!hallInfoOpen}>
            <small>{hall.chapter}</small>
            <p>{hall.text}</p>
            <span>{zonesData.levels[hall.level as StoreyLevel].title} · 展陈设计文件第 {pagesText(hall.pages)} 页</span>
            <CreativeLinks className="center-hall-creative" title="本厅故事文创" match={t => t.hall === hall.id} />
          </div>
          <nav aria-label="展厅切换">
            {step >= 0 && <>
              <button disabled={step === 0} onClick={() => enterHall(ROUTE[step - 1])} title={step > 0 ? `上一展厅：${ROUTE[step - 1].name}` : ''} aria-label="上一展厅"><ChevronLeft size={16} /></button>
              <b>{step + 1}/{ROUTE.length}</b>
              <button disabled={step === ROUTE.length - 1} onClick={() => enterHall(ROUTE[step + 1])} title={step < ROUTE.length - 1 ? `下一展厅：${ROUTE[step + 1].name}` : ''} aria-label="下一展厅"><ChevronRight size={16} /></button>
            </>}
            <button className="exit" onClick={leaveHall} title="回到楼层视图（Esc）"><LogOut size={15} />离开</button>
          </nav>
        </section>
      )}

      {status.state !== 'ready' && (
        <span className="center-status" role="status">
          {status.state === 'error' ? '传承中心模型暂未能载入，请刷新重试' : `正在载入传承中心模型 ${status.loaded}/${status.total}…`}
        </span>
      )}
      {status.state === 'ready' && <span className="center-hint">{hall ? '拖动环视 · 滚轮前后 · 右键平移 · Esc 离开展厅' : '拖动旋转 · 滚轮缩放 · 右键平移 · 点击地面查看房间'}</span>}
    </div>
  )
}
