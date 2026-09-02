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

/** 标注可选颜色 */
export const SWATCHES = ['#e8a33d', '#ff5a45', '#4a90e2', '#39c2d7', '#4caf7a', '#a06be0', '#e39ab0', '#f2efe8']

export const MIN_PAIRS = 4
export const MAX_PAIRS = 20
