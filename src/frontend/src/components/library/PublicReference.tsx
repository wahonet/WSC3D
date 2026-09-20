import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { getDocumentPage, pageImageUrl } from '../../api'
import type { DocumentTarget } from '../../lib/navigation'
import type { PageDetail } from '../../types'

export default function PublicReference({ target, onClose }: { target: DocumentTarget; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [pageNo, setPageNo] = useState(target.pageNo || 1)
  const [page, setPage] = useState<PageDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => { setPageNo(target.pageNo || 1) }, [target])
  useEffect(() => {
    let current = true
    setPage(null); setError('')
    getDocumentPage(target.documentId, pageNo)
      .then(value => { if (current) setPage(value) }).catch(reason => { if (current) setError(reason.message) })
    return () => { current = false }
  }, [target.documentId, pageNo])
  useEffect(() => {
    if (page) text.current?.querySelector('.highlight')?.scrollIntoView({ block: 'nearest' })
  }, [page, target.segmentId])
  return <dialog className="public-reference" ref={dialog} aria-label="文献原页" onCancel={onClose}>
    <div className="public-reference-shell">
      <header><BookOpen size={17} /><strong>{page?.document_title || '文献原页'}</strong><button onClick={onClose} aria-label="关闭文献原页"><X size={19} /></button></header>
      {!page ? <p style={{ padding: 20 }} role="status">{error || '载入原页…'}</p> : <div className="public-reference-body">
        <div className="public-reference-image"><img src={pageImageUrl(page.id)} alt={`${page.document_title}第${page.page_no}页`} /></div>
        <div className="public-reference-text" ref={text}>{page.segments.filter(segment => !['page_number', 'header', 'footer'].includes(segment.kind) && segment.review_status !== 'rejected').map(segment =>
          <p key={segment.id} className={segment.id === target.segmentId ? 'highlight' : undefined}>{segment.text_edit || segment.text}</p>)}
          {!page.segments.length && <p>{page.text || '本页暂无文字'}</p>}
        </div>
      </div>}
      <footer><button aria-label="上一页" disabled={pageNo <= 1} onClick={() => setPageNo(value => value - 1)}><ChevronLeft size={17} /></button><span>第 {pageNo} 页{page && ` / ${page.page_count}`}</span><button aria-label="下一页" disabled={!page || pageNo >= page.page_count} onClick={() => setPageNo(value => value + 1)}><ChevronRight size={17} /></button></footer>
    </div>
  </dialog>
}
