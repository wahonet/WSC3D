import type { AnnotateShape, GroupKey, Level, ReviewStatus, SegEngine, Tool } from '../types'

/* ---------------- 结构树 ---------------- */
/** 结构层级：显示名 / 单字徽标 / 树中排序权重 */
export const LEVELS: { id: Level; label: string; short: string; rank: number }[] = [
  { id: 'whole', label: '整石', short: '石', rank: 0 },
  { id: 'band', label: '花纹带', short: '带', rank: 1 },
  { id: 'layer', label: '层', short: '层', rank: 1 },
  { id: 'scene', label: '场景', short: '景', rank: 2 },
  { id: 'figure', label: '人物·物象', short: '物', rank: 3 },
  { id: 'component', label: '部件', short: '件', rank: 4 },
  { id: 'inscription', label: '榜题', short: '榜', rank: 3 },
  { id: 'trace', label: '刻线', short: '线', rank: 4 },
  { id: 'damage', label: '残损', short: '损', rank: 3 },
]
export const LEVEL_LABEL: Record<string, string> = Object.fromEntries(LEVELS.map(l => [l.id, l.label]))
export const LEVEL_SHORT: Record<string, string> = Object.fromEntries(LEVELS.map(l => [l.id, l.short]))
export const LEVEL_RANK: Record<string, number> = Object.fromEntries(LEVELS.map(l => [l.id, l.rank]))
/** 某层级的子节点默认层级 */
export const CHILD_LEVEL: Record<string, Level> = {
  whole: 'layer', band: 'component', layer: 'scene', scene: 'figure', figure: 'component',
  component: 'component', inscription: 'component', trace: 'trace', damage: 'damage', '': 'figure',
}
/** 结构层级的描边风格：容器类粗线无填充，人物类细线淡填充 */
export const LEVEL_STYLE: Record<string, { width: number; fill: number; dash?: string }> = {
  whole: { width: 2.6, fill: 0 }, band: { width: 2, fill: 0.04 }, layer: { width: 2.4, fill: 0 },
  scene: { width: 1.9, fill: 0.05 }, figure: { width: 1.6, fill: 0.11 }, component: { width: 1.3, fill: 0.1 },
  inscription: { width: 1.4, fill: 0.08, dash: '3 2' }, trace: { width: 1.2, fill: 0 },
  damage: { width: 1.4, fill: 0.06, dash: '2 3' }, '': { width: 1.6, fill: 0.11 },
}

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  candidate: '候选', reviewed: '已审', approved: '已核定', rejected: '已否决',
}
export const REVIEW_TONE: Record<ReviewStatus, 'cyan' | 'blue' | 'green' | 'red'> = {
  candidate: 'cyan', reviewed: 'blue', approved: 'green', rejected: 'red',
}

/** 画面语义色（与 CSS 变量保持一致） */
export const COLORS = {
  amber: '#e8a33d',      // 默认标注
  select: '#ff5a45',     // 选中
  seg: '#39c2d7',        // 分割候选 / 分割图层
  proj: '#a06be0',       // 跨图投影
  align: '#3d8ae0',      // 对齐记录
  alignL: '#e25544',     // 对齐左图取点
  alignR: '#3d8ae0',     // 对齐右图取点
  linked: '#e08c1a',     // 已图文关联
  posPoint: '#3fbf6f',
  negPoint: '#e25544',
} as const

export const TOOL_LABEL: Record<Tool, string> = {
  select: '选中', annotate: '绘制', measure: '测量', segment: 'SAM 分割',
}
export const TOOL_KEY: Record<Tool, string> = {
  select: 'V', annotate: 'A', measure: 'M', segment: 'S',
}
export const SHAPES: AnnotateShape[] = ['rect', 'ellipse', 'polygon', 'point']
export const SHAPE_LABEL: Record<AnnotateShape, string> = { rect: '矩形', ellipse: '圆形', polygon: '多边形', point: '点' }
export const SHAPE_KEY: Record<AnnotateShape, string> = { rect: '1', ellipse: '2', polygon: '3', point: '4' }

export const ATYPE_LABEL: Record<string, string> = {
  rect: '矩形', ellipse: '圆形', polygon: '多边形', point: '点', line: '测距',
  point3d: '三维点', line3d: '三维测距', align: '对齐', none: '无框',
}

/* ---------------- 流水线模块 ---------------- */
export type Page = 'home' | 'align' | 'segment' | 'annotate' | 'library'
export const PAGES: { id: Page; label: string; step: number | null; desc: string }[] = [
  { id: 'home', label: '首页', step: null, desc: '集中展示：画像石、图层、测量' },
  { id: 'align', label: '对齐', step: 1, desc: '各图与主图配准，接入统一坐标系' },
  { id: 'segment', label: '分割', step: 2, desc: 'SAM 与矩形 / 圆形 / 多边形，把画面切成实体' },
  { id: 'annotate', label: '标注', step: 3, desc: '给每个实体定层级、父级、类别、概念与图像志' },
  { id: 'library', label: '文献', step: 4, desc: '把释文与文献段落关联到已标注的节点' },
]
/** 各模块允许的工具（其余按键 / 按钮忽略） */
export const PAGE_TOOLS: Record<Page, Tool[]> = {
  home: ['select', 'measure'],
  align: ['select'],
  segment: ['select', 'annotate', 'segment'],
  annotate: ['select', 'annotate'],
  library: ['select'],
}

export const ENGINE_LABEL: Record<SegEngine, string> = { mobilesam: '点选 · MobileSAM', sam3: 'SAM3 文本', 'sam3.1': 'SAM3.1 文本' }
export const ENGINE_SHORT: Record<SegEngine, string> = { mobilesam: '点选', sam3: 'SAM3', 'sam3.1': 'SAM3.1' }

/** 汉画像石常用概念词预设：点击即填入提示词 */
export const PROMPT_PRESETS: [string, string][] = [
  ['人物', 'person'], ['马', 'horse'], ['车', 'chariot'], ['鸟', 'bird'],
  ['龙', 'dragon'], ['鱼', 'fish'], ['树', 'tree'], ['文字', 'text'],
]

export const GROUP_COLOR: Record<GroupKey, string> = {
  photo: '#4a90e2', photo_part: '#e39a3b', rubbing: '#9b6fd6', model: '#4caf7a',
}

/**
 * 标注调色板：18 色，色相错开、深浅交替，深/浅色主题下都可辨；
 * 不含选中高亮用的正红（COLORS.select），避免与选中态混淆。
 */
export const PALETTE = [
  '#e8a33d', '#4a90e2', '#4caf7a', '#f06292', '#a06be0', '#39c2d7',
  '#ff8a65', '#9ccc65', '#ba68c8', '#ffd54f', '#26a69a', '#7986cb',
  '#d4a373', '#64b5f6', '#c0ca33', '#ec407a', '#00acc1', '#ab47bc',
]

/** 从调色板里挑当前用得最少的颜色（并列取靠前者），使相邻标注颜色不同 */
export function pickColor(used: Iterable<string>): string {
  const count = new Map<string, number>(PALETTE.map(c => [c, 0]))
  for (const c of used) {
    const k = c.toLowerCase()
    if (count.has(k)) count.set(k, (count.get(k) ?? 0) + 1)
  }
  let best = PALETTE[0], bestN = Infinity
  for (const c of PALETTE) {
    const n = count.get(c) ?? 0
    if (n < bestN) { best = c; bestN = n }
  }
  return best
}

/** 依次分配 n 个颜色（考虑已用颜色），用于批量保存分割候选 */
export function pickColors(used: string[], n: number): string[] {
  const acc = [...used]
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const c = pickColor(acc)
    out.push(c)
    acc.push(c)
  }
  return out
}

export const MIN_PAIRS = 4
export const MAX_PAIRS = 20
