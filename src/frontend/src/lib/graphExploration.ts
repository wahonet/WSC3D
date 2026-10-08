import type { KnowledgeGraph } from './knowledgeGraph'

export type GraphData = Pick<KnowledgeGraph, 'nodes' | 'edges'>

export function graphDegrees(graph: GraphData): Map<string, number> {
  const result = new Map(graph.nodes.map(node => [node.id, 0]))
  for (const edge of graph.edges) {
    result.set(edge.source, (result.get(edge.source) || 0) + 1)
    result.set(edge.target, (result.get(edge.target) || 0) + 1)
  }
  return result
}

export function inducedGraph(graph: GraphData, ids: Set<string>): GraphData {
  return {
    nodes: graph.nodes.filter(node => ids.has(node.id)),
    edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
  }
}

export function neighbourhood(graph: GraphData, centre: string, depth: number): GraphData {
  if (!graph.nodes.some(node => node.id === centre)) return { nodes: [], edges: [] }
  const keep = new Set([centre])
  let frontier = new Set([centre])
  for (let step = 0; step < depth; step++) {
    const next = new Set<string>()
    for (const edge of graph.edges) {
      if (frontier.has(edge.source) && !keep.has(edge.target)) next.add(edge.target)
      if (frontier.has(edge.target) && !keep.has(edge.source)) next.add(edge.source)
    }
    next.forEach(id => keep.add(id))
    frontier = next
  }
  return inducedGraph(graph, keep)
}

/** Stones can cite an entity directly or through a story containing that entity. */
export function relatedStoneNodes(graph: GraphData, centre: string): GraphData['nodes'] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  if (!nodes.has(centre)) return []
  const subjects = new Set([centre])
  for (const edge of graph.edges) {
    const other = edge.source === centre ? edge.target : edge.target === centre ? edge.source : ''
    if (nodes.get(other)?.kind === 'story') subjects.add(other)
  }
  const related = new Set([centre])
  for (const edge of graph.edges) {
    if (subjects.has(edge.source) && nodes.get(edge.target)?.kind === 'stone') related.add(edge.target)
    if (subjects.has(edge.target) && nodes.get(edge.source)?.kind === 'stone') related.add(edge.source)
  }
  return graph.nodes.filter(node => node.kind === 'stone' && related.has(node.id))
    .sort((a, b) => (a.stone_id || '').localeCompare(b.stone_id || ''))
}

