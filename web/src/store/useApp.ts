import { create } from 'zustand'
import {
  createAnnotation, createAnnotations, deleteAnnotation, getProjected, getStats, getStone, listAnnotations,
  listStones, patchAnnotation, scanAssets, segPoint, segText, setMaster,
  type AnnotationPatchBody,
} from '../api'
import { alignGeomToOverlay } from '../lib/geometry'
import type {
  AlignGeometry, Annotation, AnnotateShape, AssetBrief, ExemplarBox, OverlaySpec, OverlayTransform,
  ProjectedAnnotation, SegDetection, SegEngine, SegPoint, SegPreprocess, SegPromptMode, SegTiling, Stats,
  StoneInfo, StoneNode, Tool,
} from '../types'
import { toast } from './useToast'

export type Page = 'work' | 'research'
export type Theme = 'dark' | 'light'

export interface CreateShape {
  atype: 'rect' | 'polygon' | 'point' | 'line' | 'point3d' | 'line3d'
  geometry: Record<string, unknown>
  value?: number
  unit?: string
}

interface SegState {
  engine: SegEngine
  points: SegPoint[]          // MobileSAM 点提示
  boxes: ExemplarBox[]        // SAM3 示例框
  promptMode: SegPromptMode   // 文字 / 文字+示例框（仅文本引擎）
  preprocess: SegPreprocess
  invert: boolean
  tiling: SegTiling
  viewPreprocessed: boolean   // 查看器显示预处理图而非原图
  dets: SegDetection[]
  excluded: number[]          // 被人工剔除的候选下标
  busy: boolean
  prompt: string
  threshold: number
  lastInfo: string            // 上次推理的切块/示例信息
}

const SEG_DEFAULT: SegState = {
  engine: 'mobilesam', points: [], boxes: [], promptMode: 'text', preprocess: 'none', invert: false,
  tiling: 'none', viewPreprocessed: false, dets: [], excluded: [], busy: false, prompt: '', threshold: 0.1,
  lastInfo: '',
}

interface AppState {
  /* ---- 数据 ---- */
  stones: StoneNode[]
  stats: Stats | null
  stoneInfo: StoneInfo | null
  curStone: StoneNode | null
  curAsset: AssetBrief | null
  annos: Annotation[]
  selectedId: number | null
  backendOk: boolean

  /* ---- 界面 ---- */
  page: Page
  theme: Theme
  tool: Tool
  shape: AnnotateShape
  overlay: OverlaySpec | null
  showAnnoLayer: boolean
  showSegLayer: boolean
  projOn: boolean
  projItems: ProjectedAnnotation[]
  projReason: string
  seg: SegState
  flyTo: { id: number; nonce: number } | null
  viewerCmd: { cmd: 'zoomIn' | 'zoomOut' | 'fit'; nonce: number } | null

  /* ---- 动作 ---- */
  boot: () => Promise<void>
  loadStones: () => Promise<StoneNode[]>
  loadStats: () => Promise<void>
  rescan: () => Promise<void>
  openAsset: (stone: StoneNode, asset: AssetBrief) => Promise<void>
  closeAsset: () => void
  refreshAnnos: () => Promise<void>
  refreshStoneInfo: () => Promise<void>
  select: (id: number | null) => void
  setTool: (t: Tool) => void
  setShape: (s: AnnotateShape) => void
  setPage: (p: Page) => void
  toggleTheme: () => void
  setOverlayOpacity: (v: number) => void
  removeOverlay: () => void
  setShowAnnoLayer: (v: boolean) => void
  setShowSegLayer: (v: boolean) => void
  toggleProj: (v: boolean) => Promise<void>
  flyToAnnotation: (id: number) => void
  sendViewerCmd: (cmd: 'zoomIn' | 'zoomOut' | 'fit') => void

  createShape: (c: CreateShape) => Promise<void>
  updateAnnotation: (id: number, body: AnnotationPatchBody) => Promise<void>
  removeAnnotation: (id: number) => Promise<void>
  makeMaster: () => Promise<void>
  onAligned: (anno: Annotation, overlayAssetId: number, t: OverlayTransform) => Promise<void>

  setSegEngine: (e: SegEngine) => void
  setSegPrompt: (s: string) => void
  setSegThreshold: (v: number) => void
  setSegPromptMode: (m: SegPromptMode) => void
  setSegPreprocess: (p: SegPreprocess) => void
  setSegInvert: (v: boolean) => void
  setSegTiling: (t: SegTiling) => void
  setViewPreprocessed: (v: boolean) => void
  addSegPoint: (p: [number, number], label: 0 | 1) => void
  undoSegPoint: () => void
  addSegBox: (b: ExemplarBox) => void
  undoSegBox: () => void
  toggleSegExcluded: (i: number) => void
  clearSeg: () => void
  runPointSeg: () => Promise<void>
  runTextSeg: () => Promise<void>
  saveSeg: () => Promise<void>
}

const THEME_KEY = 'stonelab.theme'
const initialTheme = (): Theme => (localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark')

const is2d = (a: AssetBrief | null) => a != null && !a.kind.startsWith('model')

/* 地址栏 hash 记录当前资产与页面：#a=<assetId>&p=research，刷新后可恢复 */
const TOOLS: Tool[] = ['select', 'annotate', 'measure', 'segment', 'align']
const ENGINES: SegEngine[] = ['mobilesam', 'sam3', 'sam3.1']
function readHash(): { assetId: number | null; page: Page; tool: Tool | null; engine: SegEngine | null } {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''))
  const a = Number(q.get('a'))
  const t = q.get('t') as Tool | null
  const e = q.get('e') as SegEngine | null
  return {
    assetId: a > 0 ? a : null,
    page: q.get('p') === 'research' ? 'research' : 'work',
    // t / e 仅启动时读取（如 #a=5&t=segment&e=sam3），不回写
    tool: t && TOOLS.includes(t) ? t : null,
    engine: e && ENGINES.includes(e) ? e : null,
  }
}
function writeHash(assetId: number | null, page: Page) {
  const q = new URLSearchParams()
  if (assetId) q.set('a', String(assetId))
  if (page === 'research') q.set('p', 'research')
  const h = q.toString()
  history.replaceState(null, '', h ? `#${h}` : location.pathname)
}

export const useApp = create<AppState>((set, get) => ({
  stones: [],
  stats: null,
  stoneInfo: null,
  curStone: null,
  curAsset: null,
  annos: [],
  selectedId: null,
  backendOk: true,

  page: 'work',
  theme: initialTheme(),
  tool: 'select',
  shape: 'rect',
  overlay: null,
  showAnnoLayer: true,
  showSegLayer: true,
  projOn: false,
  projItems: [],
  projReason: '',
  seg: SEG_DEFAULT,
  flyTo: null,
  viewerCmd: null,

  /* ------------------------------------------------ 数据加载 */
  boot: async () => {
    document.documentElement.dataset.theme = get().theme
    try {
      let list = await get().loadStones()
      if (list.length === 0) {
        await scanAssets()
        list = await get().loadStones()
      }
      set({ backendOk: true })
      get().loadStats().catch(() => undefined)
      const { assetId, page, tool, engine } = readHash()
      if (assetId) {
        for (const stone of list) {
          const asset = stone.groups.flatMap(g => g.assets).find(a => a.id === assetId)
          if (asset) { await get().openAsset(stone, asset); break }
        }
      }
      if (page === 'research' && get().curStone) set({ page: 'research' })
      if (tool && get().curAsset) {
        const ok2d = is2d(get().curAsset)
        if (ok2d || (tool !== 'segment' && tool !== 'align')) set({ tool })
      }
      if (engine) get().setSegEngine(engine)
    } catch (e) {
      set({ backendOk: false })
      toast.error(e)
    }
  },

  loadStones: async () => {
    const list = await listStones()
    const { curStone, curAsset } = get()
    // 资产 extra（主图/坐标链）可能已变化：同步当前引用
    const st2 = curStone ? list.find(s => s.id === curStone.id) ?? null : null
    const a2 = st2 && curAsset ? st2.groups.flatMap(g => g.assets).find(a => a.id === curAsset.id) ?? null : null
    set({ stones: list, curStone: st2 ?? curStone, curAsset: a2 ?? curAsset })
    return list
  },

  loadStats: async () => {
    try { set({ stats: await getStats() }) } catch { /* 统计非关键 */ }
  },

  rescan: async () => {
    try {
      const r = await scanAssets()
      await get().loadStones()
      await get().loadStats()
      const parts = [`石头 ${r.stones}`, `新增 ${r.assets_added}`, `更新 ${r.assets_updated}`, `移除 ${r.assets_removed}`]
      if (r.previews_warming) parts.push(`后台预热预览 ${r.previews_warming}`)
      toast.ok(`扫描完成：${parts.join(' · ')}`)
    } catch (e) { toast.error(e) }
  },

  openAsset: async (stone, asset) => {
    const sameStone = get().curStone?.id === stone.id
    set({
      curStone: stone, curAsset: asset, selectedId: null, overlay: null, annos: [],
      projOn: false, projItems: [], projReason: '',
      seg: { ...get().seg, points: [], boxes: [], dets: [], excluded: [], viewPreprocessed: false, lastInfo: '' },
      tool: get().tool === 'align' && !is2d(asset) ? 'select' : get().tool,
    })
    writeHash(asset.id, get().page)
    get().refreshAnnos().catch(toast.error)
    if (!sameStone || !get().stoneInfo) {
      try { set({ stoneInfo: await getStone(stone.id) }) } catch (e) { toast.error(e) }
    }
  },

  closeAsset: () => {
    set({ curAsset: null, annos: [], selectedId: null, overlay: null, projOn: false, projItems: [] })
    writeHash(null, get().page)
  },

  refreshAnnos: async () => {
    const a = get().curAsset
    if (!a) return
    const annos = await listAnnotations(a.id)
    if (get().curAsset?.id !== a.id) return
    set({ annos })
    if (get().projOn) await fetchProjected(a.id, set)
  },

  refreshStoneInfo: async () => {
    const s = get().curStone
    if (!s) return
    try { set({ stoneInfo: await getStone(s.id) }) } catch (e) { toast.error(e) }
  },

  /* ------------------------------------------------ 界面 */
  select: id => {
    set({ selectedId: id })
    const a = get().annos.find(x => x.id === id)
    if (a?.atype === 'align') {
      const g = a.geometry as unknown as AlignGeometry
      set({ overlay: { assetId: g.target_asset_id, opacity: 0.5, transform: alignGeomToOverlay(g) } })
    }
  },
  setTool: t => set({ tool: t }),
  setShape: s => set({ shape: s, tool: 'annotate' }),
  setPage: p => { set({ page: p }); writeHash(get().curAsset?.id ?? null, p) },
  toggleTheme: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem(THEME_KEY, theme)
    document.documentElement.dataset.theme = theme
    set({ theme })
  },
  setOverlayOpacity: v => set(s => ({ overlay: s.overlay ? { ...s.overlay, opacity: v } : null })),
  removeOverlay: () => set({ overlay: null }),
  setShowAnnoLayer: v => set({ showAnnoLayer: v }),
  setShowSegLayer: v => set({ showSegLayer: v }),

  toggleProj: async v => {
    set({ projOn: v, projReason: '' })
    const a = get().curAsset
    if (v && a) {
      const ok = await fetchProjected(a.id, set).catch(e => { set({ projReason: String(e) }); return false })
      if (!ok) set({ projOn: false })
    }
  },

  flyToAnnotation: id => set({ flyTo: { id, nonce: Date.now() }, selectedId: id }),
  sendViewerCmd: cmd => set({ viewerCmd: { cmd, nonce: Date.now() } }),

  /* ------------------------------------------------ 标注 */
  createShape: async c => {
    const { curStone, curAsset } = get()
    if (!curStone || !curAsset) return
    try {
      const isLine = c.atype === 'line' || c.atype === 'line3d'
      const created = await createAnnotation({
        stone_id: curStone.id, asset_id: curAsset.id,
        tool: isLine ? 'measure' : 'annotate', atype: c.atype, geometry: c.geometry,
        label: isLine ? '测量' : '未命名', value: c.value ?? null, unit: c.unit ?? '',
      })
      await get().refreshAnnos()
      set({ selectedId: created.id })
      get().loadStones().catch(() => undefined)
    } catch (e) { toast.error(e) }
  },

  updateAnnotation: async (id, body) => {
    try {
      await patchAnnotation(id, body)
      await get().refreshAnnos()
    } catch (e) { toast.error(e) }
  },

  removeAnnotation: async id => {
    try {
      await deleteAnnotation(id)
      if (get().selectedId === id) set({ selectedId: null, overlay: null })
      await get().refreshAnnos()
      get().loadStones().catch(() => undefined)
      get().loadStats().catch(() => undefined)
    } catch (e) { toast.error(e) }
  },

  makeMaster: async () => {
    const { curStone, curAsset, projOn } = get()
    if (!curStone || !curAsset) return
    try {
      const r = await setMaster(curStone.id, curAsset.id)
      if (!r.ok) { toast.warn(r.message); return }
      toast.ok(r.message)
      await get().loadStones()
      if (projOn) await fetchProjected(curAsset.id, set)
    } catch (e) { toast.error(e) }
  },

  onAligned: async (anno, overlayAssetId, t) => {
    set({ overlay: { assetId: overlayAssetId, opacity: 0.5, transform: t }, tool: 'select' })
    await get().refreshAnnos()
    set({ selectedId: anno.id })
    get().loadStones().catch(() => undefined)   // 对齐可能更新了坐标链，刷新资产 extra
  },

  /* ------------------------------------------------ 分割 */
  setSegEngine: e => set(s => ({ seg: { ...s.seg, engine: e, points: [], boxes: [], dets: [], excluded: [], lastInfo: '' } })),
  setSegPrompt: p => set(s => ({ seg: { ...s.seg, prompt: p } })),
  setSegThreshold: v => set(s => ({ seg: { ...s.seg, threshold: v } })),
  setSegPromptMode: m => set(s => ({ seg: { ...s.seg, promptMode: m } })),
  setSegPreprocess: p => set(s => ({
    seg: { ...s.seg, preprocess: p, viewPreprocessed: p === 'none' ? false : s.seg.viewPreprocessed },
  })),
  setSegInvert: v => set(s => ({ seg: { ...s.seg, invert: v } })),
  setSegTiling: t => set(s => ({ seg: { ...s.seg, tiling: t } })),
  setViewPreprocessed: v => set(s => ({ seg: { ...s.seg, viewPreprocessed: v } })),
  addSegPoint: (p, label) => set(s => s.seg.engine === 'mobilesam'
    ? { seg: { ...s.seg, points: [...s.seg.points, { p, label }] } } : {}),
  undoSegPoint: () => set(s => ({ seg: { ...s.seg, points: s.seg.points.slice(0, -1) } })),
  addSegBox: b => set(s => ({ seg: { ...s.seg, boxes: [...s.seg.boxes, b] } })),
  undoSegBox: () => set(s => ({ seg: { ...s.seg, boxes: s.seg.boxes.slice(0, -1) } })),
  toggleSegExcluded: i => set(s => ({
    seg: {
      ...s.seg,
      excluded: s.seg.excluded.includes(i) ? s.seg.excluded.filter(x => x !== i) : [...s.seg.excluded, i],
    },
  })),
  clearSeg: () => set(s => ({ seg: { ...s.seg, points: [], boxes: [], dets: [], excluded: [], lastInfo: '' } })),

  runPointSeg: async () => {
    const { curAsset, seg } = get()
    if (!curAsset || seg.points.length === 0) return
    set(s => ({ seg: { ...s.seg, busy: true } }))
    try {
      const r = await segPoint({
        asset_id: curAsset.id, points: seg.points.map(x => x.p), labels: seg.points.map(x => x.label),
      })
      if (!r.ok) { toast.error(r.error ?? '分割失败'); return }
      set(s => ({ seg: { ...s.seg, dets: (r.polygons ?? []).map(poly => ({ polygon: poly, score: r.score ?? 1 })) } }))
    } catch (e) { toast.error(e) } finally { set(s => ({ seg: { ...s.seg, busy: false } })) }
  },

  runTextSeg: async () => {
    const { curAsset, seg } = get()
    const prompt = seg.prompt.trim()
    const boxes = seg.promptMode === 'box' ? seg.boxes : []
    if (!curAsset || (!prompt && boxes.length === 0)) return
    set(s => ({ seg: { ...s.seg, busy: true } }))
    try {
      const r = await segText({
        asset_id: curAsset.id, prompt, engine: seg.engine === 'mobilesam' ? 'sam3' : seg.engine,
        threshold: seg.threshold, max_results: 60,
        boxes, preprocess: seg.preprocess, invert: seg.invert, tiling: seg.tiling,
      })
      if (!r.ok) { toast.error(r.error ?? '分割失败'); return }
      const dets = r.detections ?? []
      const info = [
        r.tiles ? `整图 + ${r.tiles} 切块` : '整图',
        r.exemplars ? `${r.exemplars} 示例框` : '',
        r.preprocess && r.preprocess !== 'none' ? (r.preprocess === 'rubbing' ? '仿拓片' : '增强') : '',
      ].filter(Boolean).join(' · ')
      set(s => ({ seg: { ...s.seg, dets, excluded: [], lastInfo: info } }))
      if (dets.length === 0) toast.warn(`未检出目标（${info}），可降低阈值、换预处理或加示例框重试`)
      else toast.ok(`检出 ${dets.length} 个候选（${info}），点击候选可剔除`)
    } catch (e) { toast.error(e) } finally { set(s => ({ seg: { ...s.seg, busy: false } })) }
  },

  saveSeg: async () => {
    const { curStone, curAsset, seg } = get()
    const keep = seg.dets.filter((_, i) => !seg.excluded.includes(i))
    if (!curStone || !curAsset || keep.length === 0) return
    try {
      const prompt = seg.prompt.trim()
      const label = seg.engine === 'mobilesam' ? 'SAM点选'
        : `${seg.engine}:${prompt || '示例框'}`
      const extra = seg.engine === 'mobilesam' ? ''
        : ` pre=${seg.preprocess} tiling=${seg.tiling}${seg.promptMode === 'box' ? ` exemplars=${seg.boxes.length}` : ''}`
      await createAnnotations(keep.map(d => ({
        stone_id: curStone.id, asset_id: curAsset.id, tool: 'segment', atype: 'polygon',
        geometry: { points: d.polygon }, label,
        note: `machine_proposal score=${d.score.toFixed(3)} engine=${seg.engine}${extra}`,
        color: '#39c2d7',
      })))
      set(s => ({ seg: { ...s.seg, points: [], dets: [], excluded: [] } }))
      await get().refreshAnnos()
      get().loadStones().catch(() => undefined)
      toast.ok(`已保存 ${keep.length} 个掩膜为分割图层（机器候选，须人工核对）`)
    } catch (e) { toast.error(e) }
  },
}))

async function fetchProjected(assetId: number, set: (p: Partial<AppState>) => void): Promise<boolean> {
  const r = await getProjected(assetId)
  if (!r.ok) {
    set({ projItems: [], projReason: r.reason ?? '' })
    return false
  }
  set({ projItems: r.items, projReason: r.items.length === 0 ? '同石其他图上暂无可投影的标注' : '' })
  return true
}

/* ---- 派生选择器 ---- */
export const selectIs2d = (s: AppState) => is2d(s.curAsset)
export const selectIs3d = (s: AppState) => s.curAsset != null && s.curAsset.kind.startsWith('model')
export const selectTwoDAssets = (s: AppState) =>
  s.curStone ? s.curStone.groups.filter(g => g.key !== 'model').flatMap(g => g.assets) : []
