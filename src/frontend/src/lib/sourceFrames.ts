import { nativeFrameUrl, previewUrl, workImageUrl } from '../api'
import type { Motif } from './motifCutouts'
import { imageVersion } from './imageVersions'
import { nativeMask } from './nativeMasks'

export interface OriginalPixelFrame {
  format: 'wsc-original-pixel-frame-1'
  source_sha256: string
  frame_index: number
  original_size: [number, number]
  working_size: [number, number]
  working_sha256: string
  working_rgb_sha256?: string
  working_conversion: string
  crop_pixels: [number, number, number, number]
  crop_size: [number, number]
  crop_sha256: string
}

/** An explicit original frame may never silently fall back to a resized JPEG. */
export function originalPixelFrame(item: Motif): OriginalPixelFrame | null {
  const meta = item.annotation.geometry.image_version as { segmentation?: Record<string, unknown> } | undefined
  const segmentation = meta?.segmentation
  if (!segmentation?.pixel_frame && !segmentation?.pixel_frame_record) return null
  const value = segmentation.pixel_frame as OriginalPixelFrame | undefined
  const version = imageVersion(item), mask = nativeMask(item.annotation.geometry.native_mask)
  const size = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(n => Number.isSafeInteger(n) && n > 0)
  if (!value || value.format !== 'wsc-original-pixel-frame-1' || !version || !mask ||
    value.source_sha256 !== version.source_sha256 ||
    !Number.isSafeInteger(value.frame_index) || value.frame_index < 0 ||
    !size(value.original_size) || !size(value.working_size) || !size(value.crop_size) ||
    value.original_size.some((n, i) => n !== value.working_size[i]) ||
    value.working_size[0] !== item.asset.width || value.working_size[1] !== item.asset.height ||
    typeof value.working_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.working_sha256) ||
    value.working_sha256 !== segmentation.work_image_sha256 ||
    (value.working_rgb_sha256 !== undefined && (typeof value.working_rgb_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.working_rgb_sha256))) ||
    typeof value.crop_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.crop_sha256) || value.crop_sha256 !== segmentation.crop_sha256 ||
    !Array.isArray(value.crop_pixels) || value.crop_pixels.length !== 4 ||
    !value.crop_pixels.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('原像素来源记录不一致，不能改用缩图切图')
  const [x0, y0, x1, y1] = value.crop_pixels, [width, height] = value.working_size
  if (x0 >= x1 || y0 >= y1 || x1 > width || y1 > height ||
    value.crop_size[0] !== x1 - x0 || value.crop_size[1] !== y1 - y0 ||
    mask.size[0] !== y1 - y0 || mask.size[1] !== x1 - x0 ||
    mask.extent.some((n, i) => Math.abs(n - [x0/width, y0/height, x1/width, y1/height][i]) > 1e-12)) {
    throw new Error('掩膜与原像素裁片框架不一致，禁止放大掩膜')
  }
  return value
}

/** Full-size exports and saved provenance choose the identical source and pixel frame. */
export function cutoutSource(item: Motif, members?: Motif[]): { url: string; frame: OriginalPixelFrame | null } {
  const participants = [item, ...(members ?? [])]
  if (participants.some(member => member.asset.id !== item.asset.id)) throw new Error('形象组合必须使用同一本源图像')
  const frames = participants.map(originalPixelFrame).filter((frame): frame is OriginalPixelFrame => Boolean(frame))
  const frame = frames.find(value => value.working_rgb_sha256) ?? frames[0] ?? null
  if (frame) {
    if (frames.some(other => other.source_sha256 !== frame.source_sha256 || other.frame_index !== frame.frame_index ||
      (other.working_rgb_sha256 && frame.working_rgb_sha256
        ? other.working_rgb_sha256 !== frame.working_rgb_sha256
        : other.working_sha256 !== frame.working_sha256))) throw new Error('形象组合使用了不同像素帧')
    for (const member of participants) {
      const mask = nativeMask(member.annotation.geometry.native_mask)
      if (mask && (Math.abs(mask.size[1] - (mask.extent[2]-mask.extent[0])*frame.working_size[0]) > 1e-6 ||
        Math.abs(mask.size[0] - (mask.extent[3]-mask.extent[1])*frame.working_size[1]) > 1e-6)) {
        throw new Error('组合掩膜不是该原帧的原像素结果，禁止放大')
      }
    }
    return { url: nativeFrameUrl(item.asset.id, frame.source_sha256, frame.frame_index, frame.working_sha256, frame.working_rgb_sha256), frame }
  }
  return { url: participants.some(member => member.annotation.geometry.native_mask) ? workImageUrl(item.asset.id) : previewUrl(item.asset.id), frame: null }
}
