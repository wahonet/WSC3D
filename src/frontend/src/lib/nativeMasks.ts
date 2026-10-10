/** Lossless SAM masks in their own source frame; polygons remain legacy selection outlines. */
export interface NativeMask {
  format: 'wsc-binary-mask-rle-1'
  size: [number, number] // height, width
  counts: number[] // row-major, beginning with background
  extent: [number, number, number, number] // normalized source region
  foreground_pixels: number
  binary_sha256: string
}

export const MAX_NATIVE_MASK_PIXELS = 67_108_864
const validated = new WeakSet<object>()
export function nativeMask(value: unknown): NativeMask | null {
  if (value == null) return null
  if (typeof value !== 'object') throw new Error('分割掩膜数据无效')
  if (validated.has(value)) return value as NativeMask
  const mask = value as NativeMask
  if (mask.format !== 'wsc-binary-mask-rle-1' || !Array.isArray(mask.size) || mask.size.length !== 2 ||
    !mask.size.every(n => Number.isSafeInteger(n) && n > 0) || mask.size[0] * mask.size[1] > MAX_NATIVE_MASK_PIXELS ||
    !Array.isArray(mask.counts) || !mask.counts.length || mask.counts.length > mask.size[0] * mask.size[1] + 1 ||
    !mask.counts.every(n => Number.isSafeInteger(n) && n >= 0) ||
    mask.counts.reduce((sum, n) => sum + n, 0) !== mask.size[0] * mask.size[1] ||
    mask.counts.reduce((sum, n, i) => sum + (i % 2 ? n : 0), 0) !== mask.foreground_pixels || !mask.foreground_pixels ||
    !Array.isArray(mask.extent) || mask.extent.length !== 4 ||
    !mask.extent.every(n => Number.isFinite(n) && n >= 0 && n <= 1) ||
    mask.extent[0] >= mask.extent[2] || mask.extent[1] >= mask.extent[3] ||
    typeof mask.binary_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(mask.binary_sha256)) {
    throw new Error('分割掩膜数据无效，不能以粗略轮廓替代')
  }
  validated.add(mask)
  return mask
}

export function nativeMaskBounds(mask: NativeMask): [number, number, number, number] {
  const [height, width] = mask.size
  let offset = 0, minX = width, minY = height, maxX = 0, maxY = 0
  mask.counts.forEach((count, i) => {
    if (i % 2 && count) {
      const firstRow = Math.floor(offset / width), lastRow = Math.floor((offset + count - 1) / width)
      minY = Math.min(minY, firstRow); maxY = Math.max(maxY, lastRow + 1)
      if (firstRow === lastRow) {
        minX = Math.min(minX, offset % width); maxX = Math.max(maxX, (offset + count - 1) % width + 1)
      } else { minX = 0; maxX = width }
    }
    offset += count
  })
  const [x0, y0, x1, y1] = mask.extent
  return [x0 + minX / width * (x1 - x0), y0 + minY / height * (y1 - y0),
    x0 + maxX / width * (x1 - x0), y0 + maxY / height * (y1 - y0)]
}

const canvases = new WeakMap<NativeMask, HTMLCanvasElement>()

/**
 * Maximal foreground intervals [start, end) of each row, read straight from the RLE.
 * Everything below works on runs instead of pixels: a 900 × 5000 mask holds 4.5 million
 * pixels but only a few thousand runs, so outlines no longer cost seconds per mask.
 */
const rowRuns = new WeakMap<NativeMask, number[][]>()
function maskRows(mask: NativeMask): number[][] {
  const cached = rowRuns.get(mask)
  if (cached) return cached
  const [height, width] = mask.size
  const rows: number[][] = Array.from({ length: height }, () => [])
  const add = (y: number, start: number, end: number) => {
    const row = rows[y]
    // A zero-length background run between two foreground runs joins them, as pixels would.
    if (row.length && row[row.length - 1] === start) row[row.length - 1] = end
    else row.push(start, end)
  }
  let offset = 0
  mask.counts.forEach((count, i) => {
    if (i % 2 && count) {
      let position = offset
      const stop = offset + count
      while (position < stop) {
        const y = Math.floor(position / width), x = position - y * width
        const end = Math.min(width, x + stop - position)
        add(y, x, end)
        position += end - x
      }
    }
    offset += count
  })
  rowRuns.set(mask, rows)
  return rows
}

/** Parts of the sorted, disjoint intervals `a` not covered by `b` (flat [start, end, …] lists). */
function subtractRuns(a: number[], b: number[] | undefined): number[] {
  if (!b || !b.length) return a
  const out: number[] = []
  let j = 0
  for (let i = 0; i < a.length; i += 2) {
    let start = a[i]
    const end = a[i + 1]
    while (j < b.length && b[j + 1] <= start) j += 2
    let k = j
    while (start < end && k < b.length && b[k] < end) {
      if (b[k] > start) out.push(start, b[k])
      start = Math.max(start, b[k + 1])
      k += 2
    }
    if (start < end) out.push(start, end)
  }
  return out
}

/** Pixel-exact SVG fill and exterior/interior edges, including separate one-pixel pieces. */
const paths = new WeakMap<NativeMask, { fill: string; boundary: string }>()
export function nativeMaskPaths(mask: NativeMask): { fill: string; boundary: string } {
  const cached = paths.get(mask)
  if (cached) return cached
  const height = mask.size[0], rows = maskRows(mask)
  const fill: string[] = [], boundary: string[] = []
  for (let y = 0; y < height; y++) {
    const row = rows[y]
    for (let i = 0; i < row.length; i += 2) fill.push(`M${row[i]} ${y}h${row[i+1]-row[i]}v1h${row[i]-row[i+1]}z`)
    // Top edges, then bottom edges: the run is exposed where the neighbouring row is empty.
    const top = subtractRuns(row, y > 0 ? rows[y - 1] : undefined)
    for (let i = 0; i < top.length; i += 2) boundary.push(`M${top[i]} ${y}h${top[i+1]-top[i]}`)
    const bottom = subtractRuns(row, y + 1 < height ? rows[y + 1] : undefined)
    for (let i = 0; i < bottom.length; i += 2) boundary.push(`M${bottom[i]} ${y+1}h${bottom[i+1]-bottom[i]}`)
  }
  // Vertical edges sit at each run's first pixel (left side) and last pixel (right side).
  // Join the same edge across consecutive rows, then list them column by column, left
  // before right, as a pixel scan would.
  const segments: number[][] = [] // [column, side 0 = left / 1 = right, startRow, endRow]
  let previous = new Map<number, number>() // edge key -> first row of its open segment
  for (let y = 0; y <= height; y++) {
    const row = y < height ? rows[y] : [], current = new Map<number, number>()
    for (let i = 0; i < row.length; i += 2) {
      for (const key of [row[i] * 2, (row[i + 1] - 1) * 2 + 1]) current.set(key, previous.get(key) ?? y)
    }
    previous.forEach((startRow, key) => { if (!current.has(key)) segments.push([key >> 1, key & 1, startRow, y]) })
    previous = current
  }
  segments.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
  for (const [column, side, startRow, endRow] of segments) boundary.push(`M${column + side} ${startRow}v${endRow - startRow}`)
  const value = { fill: fill.join(''), boundary: boundary.join('') }
  paths.set(mask, value)
  return value
}

export function nativeMaskCanvas(mask: NativeMask): HTMLCanvasElement {
  const cached = canvases.get(mask)
  if (cached) return cached
  const canvas = document.createElement('canvas'), [height, width] = mask.size
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器无法读取分割掩膜')
  const pixels = ctx.createImageData(width, height)
  // Opaque white wherever the mask is set: fill whole RLE spans instead of testing each pixel.
  let offset = 0
  mask.counts.forEach((count, i) => {
    if (i % 2 && count) pixels.data.fill(255, offset * 4, (offset + count) * 4)
    offset += count
  })
  ctx.putImageData(pixels, 0, 0)
  canvases.set(mask, canvas)
  return canvas
}

const previewCanvases = new WeakMap<NativeMask, Map<number, HTMLCanvasElement>>()

/** Bounded display mask: paint RLE spans without allocating a full native RGBA buffer. */
export function nativeMaskPreviewCanvas(mask: NativeMask, maxSide: number): HTMLCanvasElement {
  const [height, width] = mask.size
  if (Math.max(width, height) <= maxSide) return nativeMaskCanvas(mask)
  const cached = previewCanvases.get(mask)?.get(maxSide)
  if (cached) return cached
  const canvas = document.createElement('canvas'), scale = maxSide / Math.max(width, height)
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器无法读取分割掩膜')
  ctx.fillStyle = '#fff'
  // Coverage sampling keeps thin fragments visible; export always uses the exact native mask above.
  const span = (left: number, top: number, right: number, bottom: number) => {
    const x = Math.floor(left * canvas.width / width), y = Math.floor(top * canvas.height / height)
    ctx.fillRect(x, y, Math.ceil(right * canvas.width / width) - x, Math.ceil(bottom * canvas.height / height) - y)
  }
  let offset = 0
  mask.counts.forEach((count, i) => {
    if (i % 2 && count) {
      const first = Math.floor(offset / width), last = Math.floor((offset + count - 1) / width)
      if (first === last) span(offset % width, first, (offset + count - 1) % width + 1, first + 1)
      else {
        span(offset % width, first, width, first + 1)
        if (last > first + 1) span(0, first + 1, width, last)
        span(0, last, (offset + count - 1) % width + 1, last + 1)
      }
    }
    offset += count
  })
  const sizes = previewCanvases.get(mask) ?? new Map<number, HTMLCanvasElement>()
  sizes.set(maxSide, canvas); previewCanvases.set(mask, sizes)
  return canvas
}
