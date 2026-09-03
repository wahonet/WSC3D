import { useEffect, useState } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import { BookOpen, Link2 } from 'lucide-react'
import { listDocPages } from '../api'
import { isStructural } from '../lib/tree'
import { useApp } from '../store/useApp'
import CenterView from '../components/CenterView'
import ErrorBoundary from '../components/ErrorBoundary'
import InfoPanel from '../components/InfoPanel'
import BookShelf from '../components/library/BookShelf'
import PageWorkbench from '../components/library/PageWorkbench'
import StructurePanel from '../components/structure/StructurePanel'
import { Pane } from '../components/ui'

type Mode = 'link' | 'books'

/**
 * 模块四 · 文献：
 * - 关联释文：左结构树，中图像，右释文（拖选文字关联到选中节点）；
 * - 书库：左文献 / 页 / OCR 作业，右逐页校勘台（原刊页图 | 机器底稿 + 校订稿 + 插图）。
 */
export default function LibraryPage() {
  const nodeCount = useApp(s => s.stoneAnnos.filter(isStructural).length)
  const linked = useApp(s => s.stoneAnnos.filter(a => a.desc_text).length)
  const [mode, setMode] = useState<Mode>(() => {
    // 深链 #…&lib=books 直接打开书库（冒烟测试也用）
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('lib')
    if (fromHash === 'books' || fromHash === 'link') return fromHash
    return (localStorage.getItem('stonelab.library.mode') as Mode) || 'link'
  })
  const hashQ = new URLSearchParams(location.hash.replace(/^#/, ''))
  const [docId, setDocId] = useState<number | null>(() => Number(hashQ.get('doc')) || Number(localStorage.getItem('stonelab.library.doc')) || null)
  const [pageId, setPageId] = useState<number | null>(null)
  // 深链 &doc=<id>&pg=<物理页> 直接打开某页
  useEffect(() => {
    const d = Number(hashQ.get('doc')), pg = Number(hashQ.get('pg'))
    if (d && pg) listDocPages(d, pg - 1, 1).then(rows => { if (rows[0]) setPageId(rows[0].id) }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const outer = useDefaultLayout({ id: 'stonelab.layout.library', storage: localStorage })
  const books = useDefaultLayout({ id: 'stonelab.layout.library-books', storage: localStorage })

  const switchMode = (m: Mode) => {
    localStorage.setItem('stonelab.library.mode', m)
    const q = new URLSearchParams(location.hash.replace(/^#/, ''))
    q.set('lib', m)
    history.replaceState(null, '', `#${q.toString()}`)
    setMode(m)
  }
  const selectDoc = (id: number | null) => { localStorage.setItem('stonelab.library.doc', String(id ?? '')); setDocId(id); setPageId(null) }

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
              <Pane title={tabs}><ErrorBoundary area="书库"><BookShelf docId={docId} pageId={pageId} onSelectDoc={selectDoc} onSelectPage={setPageId} /></ErrorBoundary></Pane>
            </aside>
          </Panel>
          <Separator className="sep-h" />
          <Panel id="workbench" className="panel-clip" minSize="40%">
            <main className="center">
              <ErrorBoundary area="校勘台" resetKey={pageId ?? 0}><PageWorkbench pageId={pageId} onSelectPage={setPageId} /></ErrorBoundary>
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
