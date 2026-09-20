import type { KnowledgeGraph, KnowledgeKind, KnowledgeNode } from './knowledgeGraph'

export const FOCUS_KINDS: KnowledgeKind[] = ['story', 'person', 'object', 'stone']
export const FOCUS_LABELS: Record<KnowledgeKind, string> = { story: '故事', person: '人物', object: '物象', stone: '画像石' }
export const FOCUS_COLORS: Record<KnowledgeKind, string> = { story: '#9b634e', person: '#61827d', object: '#89769a', stone: '#a58a48' }
export const PAGE_SIZE = 8

export function focusNeighbors(data: Pick<KnowledgeGraph, 'nodes' | 'edges'>, id: string) {
  const related = new Set(data.edges.flatMap(edge => edge.source === id ? [edge.target] : edge.target === id ? [edge.source] : []))
  const order: KnowledgeKind[] = ['stone', 'story', 'person', 'object']
  return data.nodes.filter(node => node.id !== id && related.has(node.id)).sort((a, b) =>
    order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label, 'zh'))
}

/** Even spacing keeps every label legible; pagination keeps high-degree hubs usable. */
export function focusPositions(nodes: KnowledgeNode[], width = 840, height = 700) {
  return nodes.map((node, i) => {
    const angle = -Math.PI / 2 + 2 * Math.PI * i / Math.max(1, nodes.length)
    return { node, x: Math.cos(angle) * Math.max(85, (width - (width < 500 ? 136 : 168)) / 2), y: Math.sin(angle) * Math.max(100, (height - 148) / 2) }
  })
}

export function focusPage(neighbors: KnowledgeNode[], requested: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(neighbors.length / size))
  const page = Math.min(Math.max(0, requested), pages - 1)
  return { page, pages, nodes: neighbors.slice(page * size, (page + 1) * size) }
}
