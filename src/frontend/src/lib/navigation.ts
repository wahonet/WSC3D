/**
 * 跨模块跳转：所有主区域切换都落到 location.hash，App 监听 hashchange 后同步状态。
 * 文物档案、AI问答、文献中心等模块之间互相跳转时不需要持有 App 的 setState。
 */
import type { DocumentInfo } from '../types'
import { isWorkspaceSection, type SectionId } from './sections'
import { useWorkspaceAuth } from '../store/useWorkspaceAuth'

export type { SectionId } from './sections'
export type LibraryCollection = 'core' | 'extension'

/** 切换主区域并附带参数；值为 null / '' 的参数会从 hash 中移除。 */
export function goToSection(section: SectionId, params: Record<string, string | number | null | undefined> = {}) {
  const q = new URLSearchParams(location.hash.slice(1))
  q.set('section', section)
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') q.delete(key); else q.set(key, String(value))
  }
  history.pushState(null, '', '#' + q.toString())
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export interface DocumentTarget { collection: LibraryCollection; documentId: number; pageNo: number; pageId?: number | null; segmentId?: number | null; figureId?: number | null }

export function previewDocument(target: DocumentTarget) {
  window.dispatchEvent(new CustomEvent<DocumentTarget>('wsc:public-reference', { detail: target }))
}

/** 打开文献中心某一册的某一页（核心10本或扩展库），可选中一段文段。 */
export function openDocument({ collection, documentId, pageNo, pageId, segmentId, figureId }: DocumentTarget) {
  if (!useWorkspaceAuth.getState().authenticated || !isWorkspaceSection(new URLSearchParams(location.hash.slice(1)).get('section'))) {
    previewDocument({ collection, documentId, pageNo, pageId, segmentId, figureId })
    return
  }
  goToSection('library', { scope: collection, lib: 'books', doc: documentId, pg: pageNo || 1,
    seg: figureId ? null : segmentId || null, fig: figureId || null, q: null, book: null, epg: null, src: null, off: null })
  // 已经挂载的文献页直接收到定位请求；刚切换过来的页面会自行读取 hash。
  window.dispatchEvent(new CustomEvent('stonelab:open-reference', {
    detail: { collection, documentId, pageNo: pageNo || 1, pageId, segmentId: figureId ? undefined : segmentId ?? null, figureId },
  }))
}

let extensionDocuments: Promise<DocumentInfo[]> | null = null

/** 扩展库文献列表（book_id → 文献），首次使用后缓存；登记 / 扫描后调用 refreshExtensionDocuments 使其失效。 */
export function listExtensionDocuments(): Promise<DocumentInfo[]> {
  if (!extensionDocuments) {
    extensionDocuments = fetch('/api/library/documents?collection=extension')
      .then(async r => { if (!r.ok) throw new Error('无法读取扩展库文献列表'); return (await r.json()) as DocumentInfo[] })
      .catch(e => { extensionDocuments = null; throw e })
  }
  return extensionDocuments
}

export function refreshExtensionDocuments() { extensionDocuments = null }

/** 按 extension_books 编号打开扩展库的某一页；没有登记 PDF 原件时返回 false。 */
export async function openExtensionBook(bookId: string, pageNo = 1): Promise<boolean> {
  const docs = await listExtensionDocuments()
  const doc = docs.find(d => d.book_id === bookId)
  if (!doc) return false
  openDocument({ collection: 'extension', documentId: doc.id, pageNo })
  return true
}
