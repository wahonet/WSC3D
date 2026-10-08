import type { Motif } from './motifCutouts'
import { nativeMask } from './nativeMasks'

export interface ImageVersion {
  format: 'wsc-segmentation-version-1'
  canonical_annotation_id: number
  canonical_asset_id: number
  source_asset_id: number
  source_filename: string
  source_sha256: string
  source_label: string
  native_boundary_reviewed: boolean
  segmentation: Record<string, unknown>
  verified_original_alias_ids?: number[]
  source_identity_evidence?: SourceIdentityEvidence
}

interface SourceIdentityEvidence {
  format: 'wsc-source-identity-evidence-1'
  status: 'accepted'
  stone_id: string
  level: string
  canonical_annotation_id: number
  source_sha256: string
  verified_original_alias_ids: number[]
  evidence: { path: string; sha256: string }[]
}

export function imageVersion(item: Motif): ImageVersion | null {
  const value = item.annotation.geometry.image_version as Partial<ImageVersion> | undefined
  if (!value || value.format !== 'wsc-segmentation-version-1' ||
    !Number.isSafeInteger(value.canonical_annotation_id) || value.canonical_annotation_id! <= 0 ||
    !Number.isSafeInteger(value.canonical_asset_id) || value.canonical_asset_id! <= 0 ||
    value.source_asset_id !== item.asset.id || value.source_filename !== item.asset.filename ||
    typeof value.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.source_sha256) ||
    (item.asset.sha256 && item.asset.sha256 !== value.source_sha256) ||
    typeof value.source_label !== 'string' || value.native_boundary_reviewed !== true) return null
  return value as ImageVersion
}

/** Source labels describe recorded provenance; an unlabelled file never acquires an inferred author/year. */
export function imageVersionLabel(item: Motif): string {
  const explicit = imageVersion(item)?.source_label || item.asset.filename.match(/[（(]((?:19|20)\d{2}年[^）)]*)[）)]/)?.[1]
  if (explicit && !explicit.startsWith('来源批次未注明')) {
    if (item.asset.kind === 'rubbing' || explicit.includes('拓片')) return explicit.includes('拓片') ? explicit : `${explicit} · 拓片`
    const label = explicit.replace(/版本$/, '')
    return `${label}${label.includes('拍摄') ? '' : '拍摄'}版本`
  }
  return `${item.asset.kind === 'rubbing' ? '拓片' : '照片'} · ${item.asset.filename}（批次未注明）`
}

/** Explicit, checked canonical IDs associate versions; repeated labels cannot establish identity. */
export function associatedImageVersions<T extends Motif>(current: T, items: T[]): T[] {
  const local = items.filter(item => item.stone.id === current.stone.id)
  const byId = new Map(local.map(item => [item.annotation.id, item]))
  const aliases = originalAliases(byId)
  const canonical = (item: T) => canonicalId(item, byId, aliases)
  const root = canonical(current)
  const associated = local.filter(item => canonical(item) === root).sort((a, b) => a.annotation.id - b.annotation.id)
  const sources = new Map<string, T>()
  for (const item of associated) {
    const key = sourceKey(item, associated)
    const previous = sources.get(key)
    if (!previous || preciseVersion(item) > preciseVersion(previous) ||
      (preciseVersion(item) === preciseVersion(previous) && item.annotation.id > previous.annotation.id)) sources.set(key, item)
  }
  return [...sources.values()].sort((a, b) => a.annotation.id - b.annotation.id)
}

function preciseVersion(item: Motif): number {
  const version = imageVersion(item)
  if (!version) return 1
  // A checked extraction can replace a source cutout while its interpretation stays tentative.
  const objectReviewed = version.segmentation.review_policy === 'object-level-extraction-20261004'
  if (!objectReviewed && !['reviewed', 'approved'].includes(item.annotation.review_status)) return 0
  try { return nativeMask(item.annotation.geometry.native_mask) ? 2 : 0 } catch { return 0 }
}

function canonicalId<T extends Motif>(item: T, byId: Map<number, T>, aliases = new Map<number, number>()): number {
  const version = imageVersion(item)
  if (!version) return aliases.get(item.annotation.id) ?? item.annotation.id
  const base = byId.get(version.canonical_annotation_id)
  const original = base?.annotation ?? item.canonicalAnnotation
  const stoneId = base?.stone.id ?? original?.stone_id
  const assetId = base?.asset.id ?? original?.asset_id
  if (!original || original.geometry.image_version || stoneId !== item.stone.id ||
    assetId !== version.canonical_asset_id ||
    original.level !== item.annotation.level || original.id !== version.canonical_annotation_id ||
    original.id === item.annotation.id) return item.annotation.id
  return original.id
}

/** Only a reviewed native version with publisher-verified identity may name original aliases. */
function originalAliases<T extends Motif>(byId: Map<number, T>): Map<number, number> {
  const claims = new Map<number, Set<number>>()
  for (const item of byId.values()) {
    const version = imageVersion(item)
    if (!version || preciseVersion(item) !== 2 || canonicalId(item, byId) !== version.canonical_annotation_id) continue
    const ids = version.verified_original_alias_ids, proof = version.source_identity_evidence
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      !ids.every(id => Number.isSafeInteger(id) && id > 0 && id !== version.canonical_annotation_id) ||
      !proof || proof.format !== 'wsc-source-identity-evidence-1' || proof.status !== 'accepted' ||
      proof.stone_id !== item.stone.id || proof.level !== item.annotation.level ||
      proof.canonical_annotation_id !== version.canonical_annotation_id || proof.source_sha256 !== version.source_sha256 ||
      !Array.isArray(proof.verified_original_alias_ids) || proof.verified_original_alias_ids.length !== ids.length ||
      !ids.every((id, index) => proof.verified_original_alias_ids[index] === id) ||
      !Array.isArray(proof.evidence) || !proof.evidence.length || !proof.evidence.every(entry =>
        entry && typeof entry.path === 'string' && entry.path.length > 0 && /^[a-f0-9]{64}$/.test(entry.sha256))) continue
    if (!ids.every(id => {
      const original = byId.get(id)
      return original && !original.annotation.geometry.image_version && original.stone.id === item.stone.id &&
        original.annotation.level === item.annotation.level && original.asset.sha256 === version.source_sha256
    })) continue
    for (const id of ids) {
      const roots = claims.get(id) ?? new Set<number>()
      roots.add(version.canonical_annotation_id); claims.set(id, roots)
    }
  }
  const aliases = new Map<number, number>()
  for (const [id, roots] of claims) {
    const root = [...roots][0]
    // Competing claims and alias chains require a new explicit review; do not guess.
    if (roots.size === 1 && !claims.has(root)) aliases.set(id, root)
  }
  return aliases
}

function sourceKey(item: Motif, associated: Motif[]): string {
  const sameAssetVersion = associated.find(other => other.asset.id === item.asset.id && imageVersion(other))
  const sha = item.asset.sha256 || imageVersion(item)?.source_sha256 ||
    (sameAssetVersion && imageVersion(sameAssetVersion)?.source_sha256)
  return typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha) ? `sha:${sha}` : `asset:${item.asset.id}`
}

/** Old annotation URLs remain valid aliases of the preferred segmentation on that same source. */
export function preferredImageVersion<T extends Motif>(current: T, items: T[]): T {
  const versions = associatedImageVersions(current, items)
  const currentSource = sourceKey(current, [current, ...versions])
  return versions.find(item => sourceKey(item, [current, ...versions]) === currentSource) ?? current
}

/** Gallery counts and cards use one segmentation per checked canonical identity and source SHA. */
export function displayImageVersions<T extends Motif>(items: T[]): T[] {
  const selected = new Set<number>()
  for (const group of versionGroups(items).values()) {
    for (const item of preferredSources(group)) selected.add(item.annotation.id)
  }
  return items.filter(item => selected.has(item.annotation.id))
}

function versionGroups<T extends Motif>(items: T[]): Map<string, T[]> {
  const byId = new Map(items.map(item => [item.annotation.id, item]))
  const aliases = originalAliases(byId)
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = `${item.stone.id}:${canonicalId(item, byId, aliases)}`
    const group = groups.get(key) ?? []
    group.push(item); groups.set(key, group)
  }
  return groups
}

function preferredSources<T extends Motif>(group: T[]): T[] {
  const sources = new Map<string, T>()
  for (const item of group) {
    const key = sourceKey(item, group), previous = sources.get(key)
    if (!previous || preciseVersion(item) > preciseVersion(previous) ||
      (preciseVersion(item) === preciseVersion(previous) && item.annotation.id > previous.annotation.id)) sources.set(key, item)
  }
  return [...sources.values()]
}

export interface GalleryImageGroup<T extends Motif> {
  key: string
  representative: T
  versions: T[]
}

/** One card per checked identity; all source versions remain available in details. */
export function galleryImageVersionGroups<T extends Motif>(items: T[], includeCandidates = false): GalleryImageGroup<T>[] {
  return [...versionGroups(items)].flatMap(([key, group]) => {
    const versions = preferredSources(group.filter(item => includeCandidates || item.annotation.review_status !== 'candidate'))
    if (!versions.length) return []
    const representative = [...versions].sort((a, b) =>
      Number(b.asset.kind === 'rubbing') - Number(a.asset.kind === 'rubbing') ||
      Number(Boolean(b.asset.is_master)) - Number(Boolean(a.asset.is_master)) ||
      a.annotation.id - b.annotation.id)[0]
    return [{ key, representative, versions }]
  })
}
