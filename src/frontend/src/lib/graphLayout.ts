export interface LayoutGraph {
  nodes: { id: string }[]
  edges: { source: string; target: string }[]
}
export type GraphPositions = Record<string, [number, number]>

/** A bounded, deterministic layout. Run in a worker, never in the render loop. */
export function layoutGraph(graph: LayoutGraph): GraphPositions {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const n = nodes.length
  if (!n) return {}
  const indices = new Map(nodes.map((node, i) => [node.id, i]))
  const edges = graph.edges.flatMap(edge => {
    const a = indices.get(edge.source), b = indices.get(edge.target)
    return a == null || b == null || a === b ? [] : [[a, b]]
  })
  const degree = new Float64Array(n)
  for (const [a, b] of edges) { degree[a]++; degree[b]++ }
  const x = new Float64Array(n), y = new Float64Array(n)
  const dx = new Float64Array(n), dy = new Float64Array(n)
  const radius = Math.sqrt(n) * 22
  for (let i = 0; i < n; i++) {
    const angle = i * Math.PI * (3 - Math.sqrt(5))
    const r = radius * Math.sqrt((i + .5) / n)
    x[i] = Math.cos(angle) * r; y[i] = Math.sin(angle) * r
  }
  // Local repulsion uses a spatial grid; springs only visit actual edges.
  const cellSize = 110
  for (let step = 0; step < 240; step++) {
    dx.fill(0); dy.fill(0)
    const grid = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(x[i] / cellSize)},${Math.floor(y[i] / cellSize)}`
      const bucket = grid.get(key)
      if (bucket) bucket.push(i); else grid.set(key, [i])
    }
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(x[i] / cellSize), gy = Math.floor(y[i] / cellSize)
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get(`${gx + ox},${gy + oy}`) || []) {
          if (j <= i) continue
          let vx = x[i] - x[j], vy = y[i] - y[j]
          if (Math.abs(vx) + Math.abs(vy) < .001) { vx = .1; vy = .1 }
          const d2 = Math.max(16, vx * vx + vy * vy)
          const force = 620 / d2
          dx[i] += vx * force; dy[i] += vy * force
          dx[j] -= vx * force; dy[j] -= vy * force
        }
      }
    }
    for (const [a, b] of edges) {
      const vx = x[b] - x[a], vy = y[b] - y[a]
      const distance = Math.max(1, Math.hypot(vx, vy))
      const length = 55 + Math.min(80, Math.sqrt(degree[a] + degree[b]) * 9)
      const spring = (distance - length) / distance * .025
      dx[a] += vx * spring; dy[a] += vy * spring
      dx[b] -= vx * spring; dy[b] -= vy * spring
    }
    const temperature = 10 * (1 - step / 240) + .15
    for (let i = 0; i < n; i++) {
      dx[i] -= x[i] * .0025; dy[i] -= y[i] * .0025
      const length = Math.max(.001, Math.hypot(dx[i], dy[i]))
      const scale = Math.min(temperature, length) / length
      x[i] += dx[i] * scale; y[i] += dy[i] * scale
    }
  }
  return Object.fromEntries(nodes.map((node, i) => [node.id, [x[i], y[i]]]))
}
