import type { AssetBrief } from '../types'

/** 行内影像标记：批次（年份）+ 类别，没有批次信息时用文件名；主图加「主图」 */
export function imageBadge(asset: Pick<AssetBrief, 'kind' | 'kind_label' | 'filename' | 'is_master'> | undefined): string {
  if (!asset) return '未知影像'
  const kind = asset.kind_label || (asset.kind === 'rubbing' ? '拓片' : '照片')
  const batch = asset.filename.match(/[（(]((?:19|20)\d{2}年[^）)]*)[）)]/)?.[1]
  const label = batch ? (batch.includes(kind) ? batch : `${batch} · ${kind}`) : `${kind} · ${asset.filename.replace(/\.[^.]+$/, '')}`
  return asset.is_master ? `主图 · ${label}` : label
}
