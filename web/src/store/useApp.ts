import { create } from 'zustand'
import {
  adoptGeometry, autoParent, createAnnotation, createAnnotations, createConcept, deleteAnnotation,
  deleteAnnotations, getProjected, getStats, getStone, getTaxonomy, listAnnotations, listConcepts, listStones,
  patchAnnotation, patchAnnotations, scanAssets, segPoint, segText, setMaster, stoneAnnotations,
  type AnnotationBatchItem, type AnnotationPatchBody,
} from '../api'
import { PAGE_TOOLS, PALETTE, pickColor, pickColors, type Page } from '../lib/constants'
import { alignGeomToOverlay, overlayFromChains } from '../lib/geometry'
import { hasGeometry } from '../lib/tree'
import type {
  AlignGeometry, Annotation, AnnotateShape, AssetBrief, Concept, ExemplarBox, Level, OverlaySpec,
  OverlayTransform, ProjectedAnnotation, SegDetection, SegEngine, SegPoint, SegPreprocess, SegPromptMode,
  SegTiling, Stats, StoneInfo, StoneNode, Taxonomy, Tool,
} from '../types'
import { toast } from './useToast'

export type { Page }
export type Theme = 'dark' | 'light'

export interface CreateShape {
  atype: 'rect' | 'ellipse' | 'polygon' | 'point' | 'line' | 'point3d' | 'line3d'
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
  annos: Annotation[]               // 当前资产自有的标注（查看器绘制用）
  stoneAnnos: Annotation[]          // 当前石头的全部标注（结构树数据源）
  concepts: Concept[]
  taxonomy: Taxonomy | null
  selectedId: number | null
  multiSel: number[]                // 结构树多选（批量处置）
  treeOrder: number[]               // 结构树当前可见顺序（键盘上下移动用）
  backendOk: boolean

  /* ---- 界面 ---- */
  page: Page
  theme: Theme
  tool: Tool
  shape: AnnotateShape
  overlay: OverlaySpec | null
  showAnnoLayer: boolean
  showCandidates: boolean           // 机器候选（虚线）
  showLabels: boolean               // 图上显示节点名称
  hiddenLevels: Level[]             // 图层面板里关掉的结构层级
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
  loadConcepts: () => Promise<void>
  rescan: () => Promise<void>
  openAsset: (stone: StoneNode, asset: AssetBrief) => Promise<void>
  closeAsset: () => void
  refreshAnnos: () => Promise<void>
  refreshStoneAnnos: () => Promise<void>
  refreshStoneInfo: () => Promise<void>
  select: (id: number | null) => void
  toggleMulti: (id: number) => void
  setMultiSel: (ids: number[]) => void
  setTreeOrder: (ids: number[]) => void
  setTool: (t: Tool) => void
  setShape: (s: AnnotateShape) => void
  setPage: (p: Page) => void
  toggleTheme: () => void
  setOverlayAsset: (assetId: number | null) => void
  setOverlaySpec: (o: OverlaySpec | null) => void
  setOverlayOpacity: (v: number) => void
  removeOverlay: () => void
  setShowAnnoLayer: (v: boolean) => void
  setShowCandidates: (v: boolean) => void
  setShowLabels: (v: boolean) => void
  toggleLevel: (lv: Level) => void
  toggleProj: (v: boolean) => Promise<void>
  flyToAnnotation: (id: number) => void
  sendViewerCmd: (cmd: 'zoomIn' | 'zoomOut' | 'fit') => void

  createShape: (c: CreateShape) => Promise<void>
  createPlaceholder: (parentId: number | null, level: Level, label: string) => Promise<Annotation | null>
  updateAnnotation: (id: number, body: AnnotationPatchBody) => Promise<Annotation | null>
  removeAnnotation: (id: number) => Promise<void>
  removeAnnotations: (ids: number[]) => Promise<void>
  batchPatch: (items: AnnotationBatchItem[]) => Promise<void>
  adopt: (targetId: number, sourceId: number) => Promise<void>
  runAutoParent: (ids?: number[]) => Promise<void>
  addConcept: (name: string, categoryId: string) => Promise<Concept | null>
  recolorAll: () => Promise<void>
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

/* 地址栏 hash：#a=<assetId>&p=<page>，刷新后可恢复 */
const PAGE_IDS: Page[] = ['home', 'align', 'segment', 'annotate', 'library']
const LEGACY_PAGE: Record<string, Page> = { work: 'home', research: 'library' }
const ENGINES: SegEngine[] = ['mobilesam', 'sam3', 'sam3.1']
function readHash(): { assetId: number | null; page: Page; engine: SegEngine | null } {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''))
  const a = Number(q.get('a'))
  const p = q.get('p') ?? ''
  const e = q.get('e') as SegEngine | null
  return {
    assetId: a > 0 ? a : null,
    page: PAGE_IDS.includes(p as Page) ? (p as Page) : LEGACY_PAGE[p] ?? 'home',
    engine: e && ENGINES.includes(e) ? e : null,   // 仅启动时读取，不回写
  }
}
function writeHash(assetId: number | null, page: Page) {
  const cur = new URLSearchParams(location.hash.replace(/^#/, ''))
  const q = new URLSearchParams()
  if (assetId) q.set('a', String(assetId))
  if (page !== 'home') q.set('p', page)
  // 文献模块的子页（关联释文 / 书库）与书库深链（doc / pg / 检索词 q）由页面自己维护，这里只保留
  if (page === 'library') for (const k of ['lib', 'doc', 'pg', 'q', 'seg', 'fig', 'src', 'off']) { const v = cur.get(k); if (v) q.set(k, v) }
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
  stoneAnnos: [],
  concepts: [],
  taxonomy: null,
  selectedId: null,
  multiSel: [],
  treeOrder: [],
  backendOk: true,

  page: 'home',
  theme: initialTheme(),
  tool: 'select',
  shape: 'rect',
  overlay: null,
  showAnnoLayer: true,
  showCandidates: true,
  showLabels: localStorage.getItem('stonelab.labels') !== 'off',
  hiddenLevels: [],
  projOn: localStorage.getItem('stonelab.proj') !== 'off',   // 跨图投影：默认开启，偏好跨资产记忆
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
      get().loadConcepts().catch(() => undefined)
      const { assetId, page, engine } = readHash()
      set({ page, tool: 'select' })
      if (assetId) {
        for (const stone of list) {
          const asset = stone.groups.flatMap(g => g.assets).find(a => a.id === assetId)
          if (asset) { await get().openAsset(stone, asset); break }
        }
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

  loadConcepts: async () => {
    const [concepts, taxonomy] = await Promise.all([listConcepts(), get().taxonomy ? Promise.resolve(get().taxonomy!) : getTaxonomy()])
    set({ concepts, taxonomy })
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
      curStone: stone, curAsset: asset, overlay: null, annos: [],
      selectedId: sameStone ? get().selectedId : null, multiSel: sameStone ? get().multiSel : [],
      stoneAnnos: sameStone ? get().stoneAnnos : [],
      projItems: [], projReason: '',
      seg: { ...get().seg, points: [], boxes: [], dets: [], excluded: [], viewPreprocessed: false, lastInfo: '' },
    })
    writeHash(asset.id, get().page)
    get().refreshAnnos().catch(toast.error)   // 内含按 projOn 拉取跨图投影，并刷新全石标注
    if (!sameStone || !get().stoneInfo) {
      try { set({ stoneInfo: await getStone(stone.id) }) } catch (e) { toast.error(e) }
    }
  },

  closeAsset: () => {
    set({ curAsset: null, annos: [], selectedId: null, overlay: null, projItems: [] })
    writeHash(null, get().page)
  },

  refreshAnnos: async () => {
    const a = get().curAsset
    if (!a) return
    const [annos] = await Promise.all([listAnnotations(a.id), get().refreshStoneAnnos()])
    if (get().curAsset?.id !== a.id) return
    set({ annos })
    if (get().projOn && is2d(a)) await fetchProjected(a.id, set, get)
  },

  refreshStoneAnnos: async () => {
    const s = get().curStone
    if (!s) return
    const rows = await stoneAnnotations(s.id)
    if (get().curStone?.id !== s.id) return
    const ids = new Set(rows.map(r => r.id))
    set(st => ({
      stoneAnnos: rows,
      selectedId: st.selectedId != null && !ids.has(st.selectedId) ? null : st.selectedId,
      multiSel: st.multiSel.filter(i => ids.has(i)),
    }))
  },

  refreshStoneInfo: async () => {
    const s = get().curStone
    if (!s) return
    try { set({ stoneInfo: await getStone(s.id) }) } catch (e) { toast.error(e) }
  },

  /* ------------------------------------------------ 界面 */
  select: id => {
    set({ selectedId: id, multiSel: [] })
    const a = get().annos.find(x => x.id === id)
    if (a?.atype === 'align') {
      const g = a.geometry as unknown as AlignGeometry
      set({ overlay: { assetId: g.target_asset_id, opacity: 0.5, transform: alignGeomToOverlay(g) } })
    }
  },
  toggleMulti: id => set(s => {
    const base = s.multiSel.length ? s.multiSel : (s.selectedId != null ? [s.selectedId] : [])
    const next = base.includes(id) ? base.filter(i => i !== id) : [...base, id]
    return { multiSel: next, selectedId: next.length === 1 ? next[0] : s.selectedId }
  }),
  setMultiSel: ids => set({ multiSel: ids }),
  setTreeOrder: ids => set({ treeOrder: ids }),
  setTool: t => { if (PAGE_TOOLS[get().page].includes(t)) set({ tool: t }) },
  setShape: s => { if (PAGE_TOOLS[get().page].includes('annotate')) set({ shape: s, tool: 'annotate' }) },
  setPage: p => {
    // 模块导航（包括再次点击当前模块）都回到拖动 / 选中；绘制必须由用户主动启用。
    set({ page: p, tool: 'select', multiSel: [] })
    writeHash(get().curAsset?.id ?? null, p)
  },
  toggleTheme: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem(THEME_KEY, theme)
    document.documentElement.dataset.theme = theme
    set({ theme })
  },
  /** 把同石另一张已入链的图按坐标链叠到当前图上（首页图层面板） */
  setOverlayAsset: assetId => {
    const { curAsset, curStone, overlay } = get()
    if (assetId == null || !curAsset || !curStone) { set({ overlay: null }); return }
    const other = curStone.groups.flatMap(g => g.assets).find(a => a.id === assetId)
    const t = other ? overlayFromChains(curAsset, other) : null
    if (!other || !t) { toast.warn('两张图都要先接入主图坐标链才能叠加'); return }
    set({ overlay: { assetId, opacity: overlay?.opacity ?? 0.5, transform: t } })
  },
  setOverlaySpec: o => set({ overlay: o }),
  setOverlayOpacity: v => set(s => ({ overlay: s.overlay ? { ...s.overlay, opacity: v } : null })),
  removeOverlay: () => set({ overlay: null }),
  setShowAnnoLayer: v => set({ showAnnoLayer: v }),
  setShowCandidates: v => set({ showCandidates: v }),
  setShowLabels: v => { localStorage.setItem('stonelab.labels', v ? 'on' : 'off'); set({ showLabels: v }) },
  toggleLevel: lv => set(s => ({
    hiddenLevels: s.hiddenLevels.includes(lv) ? s.hiddenLevels.filter(x => x !== lv) : [...s.hiddenLevels, lv],
  })),

  toggleProj: async v => {
    set({ projOn: v, projReason: '', projItems: v ? get().projItems : [] })
    localStorage.setItem('stonelab.proj', v ? 'on' : 'off')
    const a = get().curAsset
    if (v && a && is2d(a)) {
      await fetchProjected(a.id, set, get).catch(e => set({ projReason: String(e) }))
    }
  },

  flyToAnnotation: id => set({ flyTo: { id, nonce: Date.now() }, selectedId: id }),
  sendViewerCmd: cmd => set({ viewerCmd: { cmd, nonce: Date.now() } }),

  /* ------------------------------------------------ 标注 / 结构节点 */
  createShape: async c => {
    const { curStone, curAsset, selectedId, stoneAnnos } = get()
    if (!curStone || !curAsset) return
    try {
      const isLine = c.atype === 'line' || c.atype === 'line3d'
      // 选中的是尚无几何的骨架节点：绘制的图形直接挂接到它，而不是新建
      const target = !isLine && selectedId != null ? stoneAnnos.find(a => a.id === selectedId) : undefined
      if (target && !hasGeometry(target) && c.atype !== 'point3d') {
        await patchAnnotation(target.id, { asset_id: curAsset.id, atype: c.atype, geometry: c.geometry })
        await get().refreshAnnos()
        get().loadStones().catch(() => undefined)
        toast.ok(`已把图形挂接到节点「${target.label}」`)
        return
      }
      const created = await createAnnotation({
        stone_id: curStone.id, asset_id: curAsset.id,
        tool: isLine ? 'measure' : 'annotate', atype: c.atype, geometry: c.geometry,
        label: isLine ? '测量' : '未命名', value: c.value ?? null, unit: c.unit ?? '',
        color: pickColor(get().annos.filter(a => a.atype !== 'align').map(a => a.color)),
        auto_parent: !isLine,
      })
      await get().refreshAnnos()
      set({ selectedId: created.id, multiSel: [] })
      get().loadStones().catch(() => undefined)
    } catch (e) { toast.error(e) }
  },

  createPlaceholder: async (parentId, level, label) => {
    const { curStone, curAsset, stones } = get()
    if (!curStone) return null
    // 骨架节点挂在主图（或当前 2D 图）上，之后再绘制几何
    const st = stones.find(s => s.id === curStone.id) ?? curStone
    const master = st.groups.flatMap(g => g.assets).find(a => a.is_master)
    const host = (curAsset && is2d(curAsset) ? curAsset : master) ?? master
    if (!host) { toast.warn('该石头没有可挂载节点的 2D 图'); return null }
    try {
      const created = await createAnnotation({
        stone_id: curStone.id, asset_id: host.id, tool: 'annotate', atype: 'none', geometry: {},
        label, level, parent_id: parentId, color: pickColor(get().stoneAnnos.map(a => a.color)),
      })
      await get().refreshAnnos()
      set({ selectedId: created.id, multiSel: [] })
      return created
    } catch (e) { toast.error(e); return null }
  },

  updateAnnotation: async (id, body) => {
    try {
      const a = await patchAnnotation(id, body)
      await get().refreshAnnos()
      return a
    } catch (e) { toast.error(e); return null }
  },

  removeAnnotation: async id => {
    try {
      const r = await deleteAnnotation(id)
      if (get().selectedId === id) set({ selectedId: null, overlay: null })
      await get().refreshAnnos()
      get().loadStones().catch(() => undefined)
      get().loadStats().catch(() => undefined)
      if (r.message && r.message.includes('子节点')) toast.ok(r.message)
    } catch (e) { toast.error(e) }
  },

  removeAnnotations: async ids => {
    if (ids.length === 0) return
    try {
      const r = await deleteAnnotations(ids)
      set(s => ({ selectedId: s.selectedId != null && ids.includes(s.selectedId) ? null : s.selectedId, multiSel: [] }))
      await get().refreshAnnos()
      get().loadStones().catch(() => undefined)
      get().loadStats().catch(() => undefined)
      toast.ok(r.message || `已删除 ${ids.length} 条`)
    } catch (e) { toast.error(e) }
  },

  batchPatch: async items => {
    if (items.length === 0) return
    try {
      await patchAnnotations(items)
      await get().refreshAnnos()
    } catch (e) { toast.error(e) }
  },

  adopt: async (targetId, sourceId) => {
    try {
      const a = await adoptGeometry(targetId, sourceId)
      await get().refreshAnnos()
      set({ selectedId: a.id, multiSel: [] })
      toast.ok(`已把候选的几何并入「${a.label}」`)
    } catch (e) { toast.error(e) }
  },

  runAutoParent: async ids => {
    const s = get().curStone
    if (!s) return
    try {
      const r = await autoParent(s.id, { ids, only_orphans: ids == null, include_candidates: true })
      await get().refreshAnnos()
      if (r.assigned === 0) toast.warn(`没有可归类的节点（跳过 ${r.skipped}：无几何、未入链或找不到包含它的容器）`)
      else toast.ok(`已把 ${r.assigned} 个节点归入所在的层 / 场景${r.skipped ? `，${r.skipped} 个无法判断` : ''}`)
    } catch (e) { toast.error(e) }
  },

  addConcept: async (name, categoryId) => {
    try {
      const c = await createConcept({ name, category_id: categoryId })
      await get().loadConcepts()
      return c
    } catch (e) { toast.error(e); return null }
  },

  /** 给当前资产的全部标注（对齐记录除外）按调色板顺序重新配色，相邻标注颜色不同 */
  recolorAll: async () => {
    const rows = get().annos.filter(a => a.atype !== 'align')
    if (rows.length === 0) return
    try {
      await patchAnnotations(rows.map((a, i) => ({ id: a.id, color: PALETTE[i % PALETTE.length] })))
      await get().refreshAnnos()
      toast.ok(`已为 ${rows.length} 条标注重新配色（${Math.min(rows.length, PALETTE.length)} 色循环）`)
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
      if (projOn) await fetchProjected(curAsset.id, set, get)
    } catch (e) { toast.error(e) }
  },

  onAligned: async (anno, overlayAssetId, t) => {
    set({ overlay: { assetId: overlayAssetId, opacity: 0.5, transform: t } })
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
      const colors = pickColors(get().annos.filter(a => a.atype !== 'align').map(a => a.color), keep.length)
      await createAnnotations(keep.map((d, i) => ({
        stone_id: curStone.id, asset_id: curAsset.id, tool: 'segment', atype: 'polygon',
        geometry: { points: d.polygon }, label,
        note: `machine_proposal score=${d.score.toFixed(3)} engine=${seg.engine}${extra}`,
        color: colors[i], review_status: 'candidate', auto_parent: true,
      })))
      set(s => ({ seg: { ...s.seg, points: [], dets: [], excluded: [] } }))
      await get().refreshAnnos()
      get().loadStones().catch(() => undefined)
      toast.ok(`已保存 ${keep.length} 个掩膜为机器候选（已按位置归入层 / 场景，到「标注」模块命名转正或删除）`)
    } catch (e) { toast.error(e) }
  },
}))

async function fetchProjected(assetId: number, set: (p: Partial<AppState>) => void,
                              get: () => AppState): Promise<boolean> {
  const r = await getProjected(assetId)
  if (get().curAsset?.id !== assetId) return false        // 期间已切换资产，丢弃过期结果
  if (!r.ok) {
    set({ projItems: [], projReason: r.reason ?? '' })
    return false
  }
  set({ projItems: r.items, projReason: r.items.length === 0 ? '同石其他图上暂无可投影的标注' : '' })
  return true
}

// 开发模式：store 模块被热更新时会生成一个全新的空状态，而已挂载的组件仍持有旧引用，
// 页面会进入半失效状态；这里改为整页刷新（地址栏 hash 会恢复当前资产）
if (import.meta.hot) {
  import.meta.hot.accept(() => window.location.reload())
}

/* ---- 派生选择器（只能返回原始值或 store 内既有引用；派生数组请在组件里 useMemo）---- */
export const selectIs2d = (s: AppState) => is2d(s.curAsset)
export const selectIs3d = (s: AppState) => s.curAsset != null && s.curAsset.kind.startsWith('model')
