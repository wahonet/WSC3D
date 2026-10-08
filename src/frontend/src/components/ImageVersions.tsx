import { associatedImageVersions, imageVersionLabel } from '../lib/imageVersions'
import type { Motif } from '../lib/motifCutouts'

export default function ImageVersions({ current, items, onSelect }: {
  current: Motif; items: Motif[]; onSelect: (annotationId: number) => void
}) {
  const versions = associatedImageVersions(current, items)
  return <section className="motif-detail-text image-versions">
    <h3>图像版本 <span>{versions.length}份来源</span></h3>
    <p>当前来源：{imageVersionLabel(current)}</p>
    <small>{current.asset.filename}</small>
    {versions.length > 1 && <div className="image-version-options">{versions.map(item =>
      <button key={item.annotation.id} aria-pressed={item.annotation.id === current.annotation.id}
        onClick={() => onSelect(item.annotation.id)} title={item.asset.filename}>
        <span>{imageVersionLabel(item)}</span>
        <small>{item.asset.filename}</small>
      </button>)}</div>}
  </section>
}
