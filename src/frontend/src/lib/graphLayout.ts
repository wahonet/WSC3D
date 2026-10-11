export interface LayoutGraph {
  nodes: { id: string }[]
  edges: { source: string; target: string }[]
}
export type GraphPositions = Record<string, [number, number]>

const EXACT_LIMIT = 1600
const GRAVITY = 1.2

/** A bounded, deterministic force layout. Run in a worker, never in the render loop. */
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
  // Hubs push harder so their leaves form readable rings instead of a single blot.
  const charge = Float64Array.from(degree, d => 1 + Math.sqrt(d) * .35)
  const k = 30, k2 = k * k
  const x = new Float64Array(n), y = new Float64Array(n)
  const dx = new Float64Array(n), dy = new Float64Array(n)
  const radius = Math.sqrt(n) * k * .7
  for (let i = 0; i < n; i++) {
    const angle = i * Math.PI * (3 - Math.sqrt(5))
    const r = radius * Math.sqrt((i + .5) / n)
    x[i] = Math.cos(angle) * r; y[i] = Math.sin(angle) * r
  }
  const steps = 320
  for (let step = 0; step < steps; step++) {
    dx.fill(0); dy.fill(0)
    if (n <= EXACT_LIMIT) repelExact(n, x, y, dx, dy, charge, k2)
    else repelGrid(n, x, y, dx, dy, charge, k2, k * 6)
    for (const [a, b] of edges) {
      const vx = x[b] - x[a], vy = y[b] - y[a]
      const distance = Math.max(.01, Math.hypot(vx, vy))
      const pull = distance / k / Math.sqrt(Math.min(degree[a], degree[b]))
      dx[a] += vx * pull; dy[a] += vy * pull
      dx[b] -= vx * pull; dy[b] -= vy * pull
    }
    const temperature = k * 2.5 * Math.pow(1 - step / steps, 1.6) + .4
    for (let i = 0; i < n; i++) {
      // Linear pull balances the summed repulsion, so separate components stay in view.
      dx[i] -= x[i] * GRAVITY * charge[i]
      dy[i] -= y[i] * GRAVITY * charge[i]
      const length = Math.max(.001, Math.hypot(dx[i], dy[i]))
      const scale = Math.min(temperature, length) / length
      x[i] += dx[i] * scale; y[i] += dy[i] * scale
    }
  }
  return Object.fromEntries(nodes.map((node, i) => [node.id, [x[i], y[i]]]))
}

function repelExact(n: number, x: Float64Array, y: Float64Array, dx: Float64Array, dy: Float64Array, charge: Float64Array, k2: number) {
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i], ci = charge[i]
    let fx = 0, fy = 0
    for (let j = i + 1; j < n; j++) {
      let vx = xi - x[j], vy = yi - y[j]
      if (vx === 0 && vy === 0) { vx = .01 * (i - j); vy = .01 }
      const d2 = vx * vx + vy * vy
      const force = k2 * ci * charge[j] / (d2 < 4 ? 4 : d2)
      fx += vx * force; fy += vy * force
      dx[j] -= vx * force; dy[j] -= vy * force
    }
    dx[i] += fx; dy[i] += fy
  }
}

// Fallback for very large graphs: neighbouring cells only, tapered to zero at the
// cut-off so nodes do not pile up along cell borders.
function repelGrid(n: number, x: Float64Array, y: Float64Array, dx: Float64Array, dy: Float64Array, charge: Float64Array, k2: number, cell: number) {
  const grid = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(x[i] / cell)},${Math.floor(y[i] / cell)}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(i); else grid.set(key, [i])
  }
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(x[i] / cell), gy = Math.floor(y[i] / cell)
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      for (const j of grid.get(`${gx + ox},${gy + oy}`) || []) {
        if (j <= i) continue
        let vx = x[i] - x[j], vy = y[i] - y[j]
        if (vx === 0 && vy === 0) { vx = .01 * (i - j); vy = .01 }
        const d2 = Math.max(4, vx * vx + vy * vy), d = Math.sqrt(d2)
        if (d >= cell) continue
        const taper = (1 - d / cell) ** 2
        const force = k2 * charge[i] * charge[j] / d2 * taper
        dx[i] += vx * force; dy[i] += vy * force
        dx[j] -= vx * force; dy[j] -= vy * force
      }
    }
  }
}
