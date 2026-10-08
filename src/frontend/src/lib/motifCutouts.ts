import type { Annotation, AssetBrief, StoneNode } from '../types'
import { nativeMask, nativeMaskBounds, nativeMaskCanvas, nativeMaskPreviewCanvas } from './nativeMasks'
import { cutoutSource } from './sourceFrames'
import { imageVersion } from './imageVersions'
import { previewUrl, workImageUrl } from '../api'

export type Point = [number, number]
export interface Motif {
  annotation: Annotation
  stone: StoneNode
  asset: AssetBrief
  points: Point[]
  ancestors: Annotation[]
  canonicalAnnotation?: Annotation
}

/** Only named, cited, saved outlines can enter the exhibition; containers and raw model candidates stay out. */
export function collectMotifs(stone: StoneNode, annotations: Annotation[]): Motif[] {
  const assets = new Map(stone.groups.flatMap(group => group.assets).map(asset => [asset.id, asset]))
  const nodes = new Map(annotations.map(annotation => [annotation.id, annotation]))
  return annotations.flatMap(annotation => {
    if (annotation.atype !== 'polygon' ||
      !['figure', 'component', 'inscription', 'band'].includes(annotation.level) ||
      !['reviewed', 'approved', 'candidate'].includes(annotation.review_status) ||
      !annotation.label.trim() || !annotation.references.some(ref => ref.kind === 'segment' && !ref.source_missing) ||
      (annotation.review_status === 'candidate' && !annotation.note.trim())) return []
    const asset = assets.get(annotation.asset_id)
    if (!asset || !['photo', 'photo_part', 'rubbing'].includes(asset.kind)) return []
    const points = validOutline(annotation.geometry.points)
    if (!points) return []
    let mask
    try { mask = nativeMask(annotation.geometry.native_mask) } catch { return [] }
    // A checked native extraction may retain its original annotate tool. Raw
    // annotation ranges still need a real mask and verified source provenance.
    if (annotation.tool !== 'segment' && (annotation.tool !== 'annotate' || !mask ||
      !imageVersion({ annotation, stone, asset, points, ancestors: [] }))) return []
    const ancestors: Annotation[] = [], seen = new Set([annotation.id])
    let parent = nodes.get(annotation.parent_id ?? -1)
    while (parent && !seen.has(parent.id) && parent.asset_id === annotation.asset_id) {
      ancestors.push(parent); seen.add(parent.id); parent = nodes.get(parent.parent_id ?? -1)
    }
    const version = annotation.geometry.image_version as { canonical_annotation_id?: number } | undefined
    const canonicalAnnotation = nodes.get(version?.canonical_annotation_id ?? -1)
    return [{ annotation, stone, asset, points, ancestors, canonicalAnnotation }]
  })
}

export function validOutline(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length < 3) return null
  if (!value.every(point => Array.isArray(point) && point.length === 2 &&
    point.every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1))) return null
  const points = value as Point[]
  const area = points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length]
    return sum + point[0] * next[1] - next[0] * point[1]
  }, 0)
  return Math.abs(area) > 1e-10 ? points : null
}

export function cutoutPlan(points: Point[], imageWidth: number, imageHeight: number, maxSide = 1200) {
  const xs = points.map(point => point[0] * imageWidth), ys = points.map(point => point[1] * imageHeight)
  const x = Math.max(0, Math.floor(Math.min(...xs)) - 3), y = Math.max(0, Math.floor(Math.min(...ys)) - 3)
  const right = Math.min(imageWidth, Math.ceil(Math.max(...xs)) + 3)
  const bottom = Math.min(imageHeight, Math.ceil(Math.max(...ys)) + 3)
  const width = right - x, height = bottom - y
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { x, y, width, height, scale, outputWidth: Math.max(1, Math.round(width * scale)), outputHeight: Math.max(1, Math.round(height * scale)) }
}

interface SourcePixels { drawable: CanvasImageSource; width: number; height: number }
const images = new Map<string, Promise<SourcePixels>>()
function sourceImage(url: string, originalPixels: boolean): Promise<SourcePixels> {
  const key = `${originalPixels ? 'rgb' : 'display'}:${url}`
  const cached = images.get(key)
  if (cached) return cached
  const decode = originalPixels ? (async (): Promise<SourcePixels> => {
    if (typeof createImageBitmap !== 'function') throw new Error('当前浏览器无法按原RGB像素读取切图')
    const response = await fetch(url)
    if (!response.ok) throw new Error('验收原帧暂时无法读取，请重试')
    // PNG metadata may retain an original ICC profile or EXIF tag. Neither may
    // alter the RGB values or orientation of the frame used to accept this mask.
    const bitmap = await createImageBitmap(await response.blob(), {
      colorSpaceConversion: 'none', imageOrientation: 'none', premultiplyAlpha: 'none',
    })
    return { drawable: bitmap, width: bitmap.width, height: bitmap.height }
  })() : new Promise<SourcePixels>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ drawable: image, width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('原图暂时无法读取，请重试'))
    image.src = url
  })
  const promise = decode.catch(error => { images.delete(key); throw error })
  images.set(key, promise)
  if (images.size > 8) images.delete(images.keys().next().value!)
  return promise
}

/** Exact polygon clipping in the original asset frame; no colour overlays or boxes are painted. */
export async function renderMotifCutout(motif: Motif, maxSide = 1200, outlines?: Point[][], members?: Motif[]): Promise<Blob> {
  return renderCutout(motif, maxSide, outlines, members, false)
}

/** Browsing uses cached JPEG source previews; downloading retains the verified native frame. */
export function renderMotifPreview(motif: Motif, maxSide = 650, outlines?: Point[][], members?: Motif[]): Promise<Blob> {
  return renderCutout(motif, maxSide, outlines, members, true)
}

async function renderCutout(motif: Motif, maxSide: number, outlines: Point[][] | undefined, members: Motif[] | undefined, preview: boolean): Promise<Blob> {
  const mask = nativeMask(motif.annotation.geometry.native_mask)
  const source = cutoutSource(motif, members)
  // Standard cached JPEGs describe frame zero; other TIFF pages retain their recorded frame.
  const cachedPreview = preview && (!source.frame || source.frame.frame_index === 0)
  const url = cachedPreview ? (maxSide > 1000 ? workImageUrl(motif.asset.id) : previewUrl(motif.asset.id)) : source.url
  const image = await sourceImage(url, !cachedPreview && Boolean(source.frame))
  if (!cachedPreview && source.frame && (image.width !== source.frame.working_size[0] || image.height !== source.frame.working_size[1])) {
    throw new Error('返回来源图像的尺寸与验收原帧不一致')
  }
  const bounds = mask ? nativeMaskBounds(mask) : null
  const region: Point[] = bounds ? [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]] : motif.points
  const plan = cutoutPlan(region, image.width, image.height, maxSide)
  const canvas = document.createElement('canvas')
  canvas.width = plan.outputWidth; canvas.height = plan.outputHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器无法生成切图')
  ctx.save(); ctx.scale(plan.scale, plan.scale); ctx.beginPath()
  region.forEach(([x, y], index) => {
    const px = x * image.width - plan.x, py = y * image.height - plan.y
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
  })
  ctx.closePath(); ctx.clip()
  if (outlines && !members?.some(member => member.annotation.geometry.native_mask)) {
    // Draw every outline with the same winding: overlapping figures form a union,
    // while the scene clip keeps fragments outside the narrative region out.
    ctx.beginPath()
    outlines.forEach(points => {
      const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1] }, 0)
      const ordered = area < 0 ? [...points].reverse() : points
      ordered.forEach(([x, y], index) => {
        const px = x * image.width - plan.x, py = y * image.height - plan.y
        if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
      })
      ctx.closePath()
    })
    ctx.clip()
  }
  ctx.drawImage(image.drawable, plan.x, plan.y, plan.width, plan.height, 0, 0, plan.width, plan.height)
  ctx.restore()
  if (mask || members?.some(member => member.annotation.geometry.native_mask)) {
    // Render the complete binary mask, including holes and isolated pieces, as the alpha channel.
    const alpha = document.createElement('canvas')
    alpha.width = canvas.width; alpha.height = canvas.height
    const alphaCtx = alpha.getContext('2d')!
    alphaCtx.scale(plan.scale, plan.scale)
    alphaCtx.imageSmoothingEnabled = false
    for (const member of members ?? [motif]) {
      const native = nativeMask(member.annotation.geometry.native_mask)
      if (native) {
        const [x0, y0, x1, y1] = native.extent
        const texture = preview ? nativeMaskPreviewCanvas(native, maxSide) : nativeMaskCanvas(native)
        alphaCtx.drawImage(texture, x0 * image.width - plan.x, y0 * image.height - plan.y,
          (x1 - x0) * image.width, (y1 - y0) * image.height)
      } else {
        alphaCtx.beginPath()
        member.points.forEach(([x, y], i) => {
          const px = x * image.width - plan.x, py = y * image.height - plan.y
          if (i === 0) alphaCtx.moveTo(px, py); else alphaCtx.lineTo(px, py)
        })
        alphaCtx.closePath(); alphaCtx.fillStyle = '#fff'; alphaCtx.fill()
      }
    }
    ctx.save(); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(alpha, 0, 0); ctx.restore()
  }
  const rotation = ((motif.asset.extra.cutout_rotation_ccw ?? 0) % 360 + 360) % 360
  let output = canvas
  if (rotation === 90 || rotation === 180 || rotation === 270) {
    output = document.createElement('canvas')
    const swapped = rotation !== 180
    output.width = swapped ? canvas.height : canvas.width; output.height = swapped ? canvas.width : canvas.height
    const upright = output.getContext('2d')!
    upright.translate(output.width / 2, output.height / 2); upright.rotate(-rotation * Math.PI / 180)
    upright.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
  }
  return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('切图保存失败')), 'image/png'))
}

export function motifProvenance(motif: Motif, members?: Motif[]) {
  const a = motif.annotation
  const source = cutoutSource(motif, members)
  return {
    format: 'wsc-motif-cutout-1', label: a.label, stone_id: motif.stone.id, stone_name: motif.stone.name,
    annotation_id: a.id, asset_id: motif.asset.id, source_filename: motif.asset.filename,
    source_kind: motif.asset.kind, review_status: a.review_status, geometry_intent: a.geometry_intent,
    native_mask: nativeMask(a.geometry.native_mask),
    source_image_url: `${location.origin}${source.url}`,
    source_pixel_frame: source.frame,
    image_version: a.geometry.image_version ?? null,
    reference_scope: motifReferenceScope(motif),
    outline: motif.points, orientation_ccw: motif.asset.extra.cutout_rotation_ccw ?? 0,
    semantics: a.semantics, note: a.note, references: a.references,
    concept_ids: [...new Set([a, ...motif.ancestors].flatMap(node => node.concept_ids))],
    source_url: `${location.origin}/#section=archive&stone=${encodeURIComponent(motif.stone.id)}`,
  }
}

/** A same-type comparison is explicitly marked by the curator; a citation alone never proves object identity. */
export function motifReferenceScope(motif: Motif): 'typology' | 'source_reference' {
  return [motif.annotation, ...motif.ancestors].some(node => node.note?.split(/\r?\n/).some(line => line.trim() === '文献关联性质：类型参照。'))
    ? 'typology' : 'source_reference'
}
