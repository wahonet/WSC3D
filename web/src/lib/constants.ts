import type { AnnotateShape, GroupKey, SegEngine, Tool } from '../types'

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
  select: '选中', annotate: '标注', measure: '测量', segment: '分割', align: '对齐',
}
export const TOOL_KEY: Record<Tool, string> = {
  select: 'V', annotate: 'A', measure: 'M', segment: 'S', align: 'L',
}
export const SHAPE_LABEL: Record<AnnotateShape, string> = { rect: '矩形', polygon: '多边形', point: '点' }
export const SHAPE_KEY: Record<AnnotateShape, string> = { rect: '1', polygon: '2', point: '3' }

export const ATYPE_LABEL: Record<string, string> = {
  rect: '矩形', polygon: '多边形', point: '点', line: '测距',
  point3d: '三维点', line3d: '三维测距', align: '对齐',
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
