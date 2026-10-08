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
const decodedMasks = new WeakMap<NativeMask, Uint8Array>()
function maskPixels(mask: NativeMask): Uint8Array {
  const cached = decodedMasks.get(mask)
  if (cached) return cached
  const binary = new Uint8Array(mask.size[0] * mask.size[1])
  let offset = 0
  mask.counts.forEach((count, i) => {
    if (i % 2) binary.fill(1, offset, offset + count)
    offset += count
  })
  decodedMasks.set(mask, binary)
  return binary
}

/** Pixel-exact SVG fill and exterior/interior edges, including separate one-pixel pieces. */
const paths = new WeakMap<NativeMask, { fill: string; boundary: string }>()
export function nativeMaskPaths(mask: NativeMask): { fill: string; boundary: string } {
  const cached = paths.get(mask)
  if (cached) return cached
  const [height, width] = mask.size, binary = maskPixels(mask)
  const fill: string[] = [], boundary: string[] = []
  for (let y = 0; y < height; y++) {
    let start = -1
    for (let x = 0; x <= width; x++) {
      const inside = x < width && binary[y * width + x]
      if (inside && start < 0) start = x
      if (!inside && start >= 0) {
        fill.push(`M${start} ${y}h${x-start}v1h${start-x}z`); start = -1
      }
    }
    for (const dy of [-1, 1]) {
      let edgeStart = -1
      for (let x = 0; x <= width; x++) {
        const edge = x < width && binary[y*width+x] && (y+dy < 0 || y+dy >= height || !binary[(y+dy)*width+x])
        if (edge && edgeStart < 0) edgeStart = x
        if (!edge && edgeStart >= 0) {
          boundary.push(`M${edgeStart} ${y+(dy>0?1:0)}h${x-edgeStart}`); edgeStart = -1
        }
      }
    }
  }
  for (let x = 0; x < width; x++) for (const dx of [-1, 1]) {
    let edgeStart = -1
    for (let y = 0; y <= height; y++) {
      const edge = y < height && binary[y*width+x] && (x+dx < 0 || x+dx >= width || !binary[y*width+x+dx])
      if (edge && edgeStart < 0) edgeStart = y
      if (!edge && edgeStart >= 0) {
        boundary.push(`M${x+(dx>0?1:0)} ${edgeStart}v${y-edgeStart}`); edgeStart = -1
      }
    }
  }
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
  maskPixels(mask).forEach((inside, p) => {
    if (inside) {
      pixels.data[p * 4] = pixels.data[p * 4 + 1] = pixels.data[p * 4 + 2] = pixels.data[p * 4 + 3] = 255
    }
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
