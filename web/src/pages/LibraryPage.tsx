import { useCallback, useEffect, useRef, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { BookOpen, Link2 } from 'lucide-react'
import { listDocPages } from '../api'
import { isStructural } from '../lib/tree'
import type { PageDetail, SearchHit } from '../types'
import { useApp } from '../store/useApp'
import { toast } from '../store/useToast'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import InfoPanel from '../components/InfoPanel'
import BookShelf from '../components/library/BookShelf'
import PageWorkbench, { type SegmentFocus } from '../components/library/PageWorkbench'
import StructurePanel from '../components/structure/StructurePanel'
import { Pane } from '../components/ui'

type Mode = 'link' | 'books'
interface ReferenceLocation {
  documentId?: number | null
  pageId?: number | null
  pageNo?: number | null
  segmentId?: number | null
  figureId?: number | null
}

function clearReferenceHash() {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''))
  q.delete('seg')
  q.delete('fig')
  history.replaceState(null, '', `#${q.toString()}`)
}

/**
 * 模块四 · 文献：
 * - 关联释文：左结构树，中图像，右释文（拖选文字关联到选中节点）；
 * - 书库：左 全库检索 + 文献 / 页 / OCR 作业，右逐页校勘台（原刊页图 | 机器底稿 + 校订稿 + 插图）；
 *   检索命中可直达任一本书的某页并选中文段，检索词在文段里高亮。
 */
export default function LibraryPage() {
  const nodeCount = useApp(s => s.stoneAnnos.filter(isStructural).length)
  const linked = useApp(s => s.stoneAnnos.filter(a => isStructural(a) && (a.references?.length || a.desc_text)).length)
  const [mode, setMode] = useState<Mode>(() => {
    // 深链 #…&lib=books 直接打开书库（冒烟测试也用）
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('lib')
    if (fromHash === 'books' || fromHash === 'link') return fromHash
    return (localStorage.getItem('stonelab.library.mode') as Mode) || 'link'
  })
  const initialHash = useRef(new URLSearchParams(location.hash.replace(/^#/, '')))
  const navigation = useRef(0)
  const [docId, setDocId] = useState<number | null>(() => Number(initialHash.current.get('doc')) || Number(localStorage.getItem('stonelab.library.doc')) || null)
  const [pageId, setPageId] = useState<number | null>(null)
  const [focus, setFocus] = useState<SegmentFocus | null>(null)
  const [highlight, setHighlight] = useState('')
  const outer = useDefaultLayout({ id: 'stonelab.layout.library', storage: localStorage })
  const books = useDefaultLayout({ id: 'stonelab.layout.library-books', storage: localStorage })

  const switchMode = useCallback((m: Mode) => {
    localStorage.setItem('stonelab.library.mode', m)
    const q = new URLSearchParams(location.hash.replace(/^#/, ''))
    q.set('lib', m)
    history.replaceState(null, '', `#${q.toString()}`)
    setMode(m)
  }, [])
  const selectDoc = useCallback((id: number | null) => {
    navigation.current++
    localStorage.setItem('stonelab.library.doc', String(id ?? ''))
    setDocId(id)
    setPageId(null)
    setFocus(null)
    clearReferenceHash()
  }, [])
  const selectPage = useCallback((id: number) => {
    navigation.current++
    setPageId(id)
    setFocus(null)
    clearReferenceHash()
  }, [])
  const openReference = useCallback((r: ReferenceLocation) => {
    switchMode('books')
    const documentId = r.documentId
    if (documentId == null || documentId <= 0) return
    const ticket = ++navigation.current
    localStorage.setItem('stonelab.library.doc', String(documentId))
    setDocId(documentId)
    setHighlight('')
    setFocus(r.figureId ? { figureId: r.figureId } : r.segmentId ? { segmentId: r.segmentId } : null)
    const q = new URLSearchParams(location.hash.replace(/^#/, ''))
    q.set('doc', String(documentId))
    if (r.pageNo) q.set('pg', String(r.pageNo)); else q.delete('pg')
    q.delete('seg')
    q.delete('fig')
    if (r.figureId) q.set('fig', String(r.figureId))
    else if (r.segmentId) q.set('seg', String(r.segmentId))
    history.replaceState(null, '', `#${q.toString()}`)
    if (r.pageId) { setPageId(r.pageId); return }
    setPageId(null)
    if (r.pageNo && r.pageNo > 0) {
      listDocPages(documentId, r.pageNo - 1, 1).then(rows => {
        if (navigation.current !== ticket) return
        if (rows[0]) setPageId(rows[0].id)
        else toast.warn('找不到引用所在的文献页')
      }).catch(e => { if (navigation.current === ticket) toast.error(e) })
    }
  }, [switchMode])

  // 节点引用列表直达书库；首次切入其他模块时从 hash 恢复同样的定位信息。
  useEffect(() => {
    const onReference = (event: Event) => {
      const detail = (event as CustomEvent<ReferenceLocation>).detail
      if (detail) openReference(detail)
    }
    const onDescription = () => switchMode('link')
    window.addEventListener('stonelab:open-reference', onReference)
    window.addEventListener('stonelab:open-description', onDescription)
    return () => {
      window.removeEventListener('stonelab:open-reference', onReference)
      window.removeEventListener('stonelab:open-description', onDescription)
    }
  }, [openReference, switchMode])
  useEffect(() => {
    const q = initialHash.current
    const d = Number(q.get('doc')), pg = Number(q.get('pg'))
    if (d > 0 && pg > 0 && q.get('lib') === 'books') openReference({
      documentId: d, pageNo: pg,
      segmentId: Number(q.get('seg')) || null, figureId: Number(q.get('fig')) || null,
    })
    return () => { navigation.current++ }
  }, [openReference])
  // 校勘台每载入一页就把 doc / pg 回写到深链，刷新或分享都落在正在看的这一页
  const onPageLoaded = useCallback((p: PageDetail) => {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''))
    h.set('doc', String(p.document_id))
    h.set('pg', String(p.page_no))
    history.replaceState(null, '', `#${h.toString()}`)
  }, [])
  // 检索命中直达：切书 + 切页 + 交给校勘台选中该文段（每次点击都是新的 focus 对象，重复点同一条也会重新滚动到位）
  const openHit = useCallback((h: SearchHit) => {
    navigation.current++
    localStorage.setItem('stonelab.library.doc', String(h.document_id))
    setDocId(h.document_id)
    setPageId(h.page_id)
    setFocus({ segmentId: h.segment_id })
    const q = new URLSearchParams(location.hash.replace(/^#/, ''))
    q.set('doc', String(h.document_id))
    q.set('pg', String(h.page_no))
    q.set('seg', String(h.segment_id))
    q.delete('fig')
    history.replaceState(null, '', `#${q.toString()}`)
  }, [])

  const tabs = (
    <span className="pane-tabs">
      <button className={`pane-tab${mode === 'link' ? ' on' : ''}`} onClick={() => switchMode('link')}><Link2 size={12} />关联释文</button>
      <button className={`pane-tab${mode === 'books' ? ' on' : ''}`} onClick={() => switchMode('books')}><BookOpen size={12} />书库</button>
    </span>
  )

  if (mode === 'books') {
    return (
      <div className="body">
        <Group orientation="horizontal" id="library-books" defaultLayout={books.defaultLayout} onLayoutChanged={books.onLayoutChanged}>
          <Panel id="shelf" className="panel-clip" defaultSize="28%" minSize="300px" maxSize="45%">
            <aside className="side">
              <Pane title={tabs}>
                <ErrorBoundary area="书库">
                  <BookShelf docId={docId} pageId={pageId} activeSegment={focus?.segmentId ?? null} onSelectDoc={selectDoc} onSelectPage={selectPage}
                    onOpenHit={openHit} onSearchChange={setHighlight} />
                </ErrorBoundary>
              </Pane>
            </aside>
          </Panel>
          <Separator className="sep-h" />
          <Panel id="workbench" className="panel-clip" minSize="40%">
            <main className="center">
              <ErrorBoundary area="校勘台" resetKey={pageId ?? 0}><PageWorkbench pageId={pageId} onSelectPage={selectPage} onLoaded={onPageLoaded} focus={focus} highlight={highlight} /></ErrorBoundary>
            </main>
          </Panel>
        </Group>
      </div>
    )
  }

  return (
    <div className="body">
      <Group orientation="horizontal" id="library" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged}>
        <Panel id="left" className="panel-clip" defaultSize="22%" minSize="250px" maxSize="40%">
          <aside className="side">
            <Pane title={tabs} count={`${linked} / ${nodeCount} 已关联`}>
              <ErrorBoundary area="结构树"><StructurePanel /></ErrorBoundary>
            </Pane>
          </aside>
        </Panel>
        <Separator className="sep-h" />
        <Panel id="center" className="panel-clip" minSize="30%">
          <CenterView mode="2d" />
        </Panel>
        <Separator className="sep-h" />
        <Panel id="right" className="panel-clip" defaultSize="32%" minSize="340px" maxSize="50%">
          <aside className="side">
            <Pane title="文献与释文">
              <ErrorBoundary area="文献"><InfoPanel /></ErrorBoundary>
            </Pane>
          </aside>
        </Panel>
      </Group>
    </div>
  )
}
