import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Moon, Sun, Sparkles, ArrowUp, UserRound, LogOut, ArrowUpRight, PanelsTopLeft } from 'lucide-react'
import ErrorBoundary from './components/ErrorBoundary'
import Toaster from './components/Toaster'
import { useShortcuts } from './hooks/useShortcuts'
import { useEntranceMotion } from './hooks/useEntranceMotion'
import AlignPage from './pages/AlignPage'
import AnnotatePage, { EvidencePage } from './pages/AnnotatePage'
import HomePage from './pages/HomePage'
import OverviewPage from './pages/OverviewPage'
import LibraryPage from './pages/LibraryPage'
import SegmentPage from './pages/SegmentPage'
import SearchPage from './pages/SearchPage'
import { useApp } from './store/useApp'
import { useStore } from './archive/store'
import Sidebar from './archive/ui/Sidebar'
import LedgerView from './archive/ui/LedgerView'
import SceneView from './archive/ui/SceneView'
import Lightbox from './archive/ui/Lightbox'
import ApiConfigPage from './pages/ApiConfigPage'
import LoginPage from './pages/LoginPage'
import PublicReference from './components/library/PublicReference'
import { goToSection, openDocument, openExtensionBook, type DocumentTarget } from './lib/navigation'
import { publicSections, workspaceSections, isWorkspaceSection, resolveSection, type SectionId, type WorkspaceSection } from './lib/sections'
import { useWorkspaceAuth } from './store/useWorkspaceAuth'
import { toast } from './store/useToast'
import './archive/scoped.css'
import './unified.css'
import './workspace.css'

const SiteStage = lazy(() => import('./archive/three/SiteStage'))
const KnowledgeGraphPage = lazy(() => import('./pages/KnowledgeGraphPage'))
const CreativeStudio = lazy(() => import('./pages/CreativeStudio'))
const CreativePage = lazy(() => import('./pages/CreativePage'))
type Section = SectionId
const researchPages = { home: HomePage, align: AlignPage, segment: SegmentPage, annotate: AnnotatePage, library: EvidencePage }
const researchTabs = [['home', '查看与测量'], ['align', '图像对齐'], ['segment', '智能分割'], ['annotate', '结构标注'], ['library', '文献举证']] as const

export default function App() {
  const initial = useRef(new URLSearchParams(location.hash.slice(1)))
  const authenticated = useWorkspaceAuth(s => s.authenticated)
  const requestedWorkspace = useRef<WorkspaceSection>(isWorkspaceSection(initial.current.get('next')) ? initial.current.get('next') as WorkspaceSection : isWorkspaceSection(initial.current.get('section')) ? initial.current.get('section') as WorkspaceSection : 'research')
  const [requestedSection, setRequestedSection] = useState<Section>(() => resolveSection(initial.current.get('section')))
  const section: Section = !authenticated && isWorkspaceSection(requestedSection) ? 'login' : requestedSection
  const workspace = isWorkspaceSection(section)
  const [manageArchive, setManageArchive] = useState(initial.current.get('manage') === 'archive')
  const archiveMaintenance = workspace && section === 'research' && manageArchive
  const [reference, setReference] = useState<DocumentTarget | null>(null)
  function setSection(next: Section) {
    if (isWorkspaceSection(next)) requestedWorkspace.current = next
    setRequestedSection(next)
  }
  const [libraryScope, setLibraryScope] = useState<'core' | 'extension'>(() => initial.current.get('scope') === 'extension' ? 'extension' : 'core')
  const [query, setQuery] = useState(initial.current.get('query') || '')
  const [submitted, setSubmitted] = useState(initial.current.get('query') || '')
  const [submissionId, setSubmissionId] = useState(0)
  const [showList, setShowList] = useState(false)
  const [bootError, setBootError] = useState('')
  const page = useApp(s => s.page)
  const curStone = useApp(s => s.curStone)
  const curAsset = useApp(s => s.curAsset)
  const theme = useApp(s => s.theme)
  const selectedId = useStore(s => s.selectedId)
  const invModule = useStore(s => s.module)
  const previousModule = useRef(invModule)
  const stageVisited = useRef(false)
  const searchVisited = useRef(false)
  if (section === 'search') searchVisited.current = true
  if (section === 'archive' || section === 'scene' || archiveMaintenance) stageVisited.current = true
  const stats = useStore(s => s.stats)
  const booted = useRef(false)
  useShortcuts(workspace && !archiveMaintenance && (section === 'research' || section === 'library'))
  useEffect(() => {
    const open = (event: Event) => setReference((event as CustomEvent<DocumentTarget>).detail)
    window.addEventListener('wsc:public-reference', open)
    return () => window.removeEventListener('wsc:public-reference', open)
  }, [])

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void useWorkspaceAuth.getState().checkSession()
    if (initial.current.get('section') === 'scene') useStore.getState().setModule('scene')
    Promise.all([useApp.getState().boot(), useStore.getState().load()]).then(() => {
      const id = initial.current.get('stone') || useApp.getState().curStone?.id || '武011'
      useStore.getState().select(id)
      const book = initial.current.get('book')
      if (book && !initial.current.has('doc')) void openExtensionBook(book, Number(initial.current.get('epg')) || 1).catch(toast.error)
    }).catch(e => setBootError(String(e)))
  }, [])

  useEffect(() => {
    setShowList(false)
    if (!selectedId || useApp.getState().curStone?.id === selectedId) return
    const state = useApp.getState()
    const stone = state.stones.find(s => s.id === selectedId)
    if (!stone) return
    const assets = stone.groups.flatMap(g => g.assets)
    const asset = assets.find(a => a.id === stone.master_asset_id) || assets.find(a => a.kind === 'photo') || assets[0]
    if (asset) void state.openAsset(stone, asset)
    else { state.closeAsset(); useApp.setState({ curStone: stone }) }
  }, [selectedId])
  useEffect(() => {
    if (curStone && curStone.id !== useStore.getState().selectedId) useStore.getState().select(curStone.id)
  }, [curStone])
  useEffect(() => {
    if (previousModule.current === invModule) return
    previousModule.current = invModule
    if (invModule === 'scene') setSection('scene')
    else if (invModule === 'books') { setSection('library'); setLibraryScope('extension') }
    else if (invModule === 'search') setSection('search')
    else if (invModule === 'ledger' && !archiveMaintenance) setSection('archive')
  }, [invModule])
  useEffect(() => {
    const q = new URLSearchParams(location.hash.slice(1))
    q.set('section', section)
    if (section === 'login') q.set('next', requestedWorkspace.current); else q.delete('next')
    if (selectedId) q.set('stone', selectedId)
    q.set('scope', libraryScope)
    if (submitted) q.set('query', submitted); else q.delete('query')
    history.replaceState(null, '', '#' + q.toString())
  }, [section, requestedSection, selectedId, libraryScope, submitted, curAsset, page])
  useEffect(() => {
    const onHash = async () => {
      const q = new URLSearchParams(location.hash.slice(1))
      const next = resolveSection(q.get('section'))
      if (isWorkspaceSection(q.get('next'))) requestedWorkspace.current = q.get('next') as WorkspaceSection
      setSection(next)
      setManageArchive(q.get('manage') === 'archive')
      setReference(null)
      if (q.get('stone')) useStore.getState().select(q.get('stone'))
      if (q.has('scope')) setLibraryScope(q.get('scope') === 'extension' ? 'extension' : 'core')
      if (q.get('book') && !q.has('doc') && next === 'library') void openExtensionBook(q.get('book')!, Number(q.get('epg')) || 1).catch(toast.error)
      setQuery(q.get('query') || ''); setSubmitted(q.get('query') || '')
      const state = useApp.getState()
      const desiredPage = q.get('p') || 'home'
      if (desiredPage in researchPages && next === 'research') state.setPage(desiredPage as keyof typeof researchPages)
      if (next === 'archive') useStore.getState().setModule('ledger')
      if (next === 'research' && q.get('manage') === 'archive') useStore.getState().setModule('ledger')
      if (next === 'scene') useStore.getState().setModule('scene')
      state.setTool('select')
      const sid = q.get('stone'), assetId = Number(q.get('a'))
      const stone = state.stones.find(s => s.id === sid)
      const asset = stone?.groups.flatMap(g => g.assets).find(a => a.id === assetId)
      if (stone && asset && state.curAsset?.id !== assetId) await state.openAsset(stone, asset)
      const nodeId = Number(q.get('node'))
      if (nodeId && useApp.getState().stoneAnnos.some(a => a.id === nodeId)) useApp.getState().select(nodeId)
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash) }
  }, [])

  function navigate(next: Section) {
    if (next !== section) { const q = new URLSearchParams(location.hash.slice(1)); q.set('section', next); history.pushState(null, '', '#' + q.toString()) }
    useApp.getState().setTool('select')
    setSection(next)
    setReference(null)
    setManageArchive(false)
    const clean = new URLSearchParams(location.hash.slice(1)); clean.delete('manage'); history.replaceState(null, '', '#' + clean)
    if (next === 'archive') useStore.getState().setModule('ledger')
    if (next === 'scene') useStore.getState().setModule('scene')
    if (next === 'research' && page === 'library') useApp.getState().setPage('home')
    if (next === 'library') {
      const q = new URLSearchParams(location.hash.slice(1)); q.set('lib', 'books'); history.replaceState(null, '', '#' + q)
      useApp.getState().setPage('library')
    }
  }
  function login() {
    goToSection(requestedWorkspace.current, { next: null })
  }
  async function logout() {
    try { await useWorkspaceAuth.getState().logout(); navigate('overview') }
    catch (reason) { toast.error((reason as Error).message) }
  }
  function submit() {
    if (!query.trim()) return
    setSubmitted(query.trim()); setSubmissionId(id => id + 1); navigate('search')
  }
  const Research = researchPages[page]
  const inventoryVisible = section === 'archive' || section === 'scene' || archiveMaintenance
  const entranceKey = section === 'research' ? `${section}:${page}` : section === 'library' ? `${section}:${libraryScope}` : section
  const entranceRef = useEntranceMotion<HTMLElement>(entranceKey, {
    liftSelector: '.museum-intro, .research-tabs, .kg-toolbar, .lg-heading, .scene-tools, .search-heading',
  })
  function switchLibrary(scope: 'core' | 'extension') {
    if (scope === libraryScope) return
    goToSection('library', { scope, lib: 'books', doc: null, pg: null, seg: null, fig: null, q: null, book: null, epg: null })
  }

  return <div className={`unified-shell${section === 'overview' ? ' overview-theme' : ''}`}>
    <header className="unified-header">
      <div className="unified-brand"><button className="unified-brand-home" onClick={() => navigate('overview')} aria-label="武氏墓群石刻首页"><img className="unified-brand-logo" src="/brand/culture-jining.png" alt="文化济宁" /><div><strong>武氏墓群石刻</strong><span>数字档案与图像研究平台</span></div></button></div>
      {workspace ? <div className="workspace-heading"><PanelsTopLeft size={18} /><strong>研究工作台</strong></div> : section !== 'login' && <form className="unified-search" onSubmit={e => { e.preventDefault(); submit() }}>
        <Sparkles size={17} /><input aria-label="向AI提问" maxLength={1000} placeholder="问 AI：输入原石名称或研究问题…" value={query} onChange={e => setQuery(e.target.value)} /><button type="submit" aria-label="提交AI问题" title="向 AI 提问（Enter）" disabled={!query.trim()}><ArrowUp size={17} /></button>
      </form>}
      <div className="workspace-header-actions">
      {workspace ? <><span className="workspace-account">admin</span><button className="workspace-public" onClick={() => navigate('overview')}>查看展示<ArrowUpRight size={14} /></button><button className="unified-icon" aria-label="退出登录" onClick={logout}><LogOut size={18} /></button></> : section !== 'login' && <button className="unified-icon" onClick={() => navigate(authenticated ? 'research' : 'login')} title={authenticated ? '进入工作台' : '工作台登录'} aria-label={authenticated ? '进入工作台' : '工作台登录'}><UserRound size={19} /></button>}
      <button className="unified-icon" onClick={() => useApp.getState().toggleTheme()} aria-label="切换明暗主题">{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button>
      </div>
    </header>
    {section !== 'login' && <nav className={`unified-nav${workspace ? ' workspace-nav' : ''}`} aria-label={workspace ? '工作台导航' : '展示导航'}>{(workspace ? workspaceSections : publicSections).map(([id, label]) => <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => navigate(id)}>{label}</button>)}</nav>}
    {bootError && <div role="alert" className="unified-error">载入失败：{bootError}<button onClick={() => location.reload()}>重新载入</button></div>}
    <main className="unified-main" ref={entranceRef}>
      <div className="function-transition" aria-hidden="true"><span className="function-transition-light" /></div>
      {section === 'login' && <LoginPage onLogin={login} onBack={() => navigate('overview')} />}
      {section === 'settings' && <ErrorBoundary area="API配置"><ApiConfigPage /></ErrorBoundary>}
      {section === 'video' && <ErrorBoundary area="电子文创工作台"><Suspense fallback={<div role="status">载入工作台…</div>}><CreativeStudio /></Suspense></ErrorBoundary>}
      {section === 'creative' && <ErrorBoundary area="电子文创"><Suspense fallback={<div role="status">载入电子文创…</div>}><CreativePage /></Suspense></ErrorBoundary>}
      {section === 'overview' && <OverviewPage onNavigate={navigate} onStone={(id, target) => { useStore.getState().select(id); navigate(target) }} />}
      {section === 'graph' && <ErrorBoundary area="知识图谱"><Suspense fallback={<div className="kg-state" role="status">载入图谱…</div>}><KnowledgeGraphPage /></Suspense></ErrorBoundary>}
      {section === 'research' && <div className="research-pane" style={archiveMaintenance ? { flex: '0 0 auto' } : undefined}><div className="research-tabs">{researchTabs.map(([id, label]) => <button key={id} className={!archiveMaintenance && page === id ? 'active' : ''} onClick={() => { setManageArchive(false); goToSection('research', { p: id, manage: null }); useApp.getState().setPage(id) }}>{label}</button>)}<span /><button className={archiveMaintenance ? 'active' : ''} onClick={() => goToSection('research', { manage: 'archive' })}>档案维护</button><button onClick={() => void useApp.getState().rescan()}>检查资源</button></div>{!archiveMaintenance && <ErrorBoundary area="图像研究" resetKey={page}><Research /></ErrorBoundary>}</div>}
      {section === 'library' && <div className="library-pane"><div className="research-tabs"><button className={libraryScope === 'core' ? 'active' : ''} onClick={() => switchLibrary('core')}>文献库</button><button className={libraryScope === 'extension' ? 'active' : ''} onClick={() => switchLibrary('extension')}>扩展库</button></div><ErrorBoundary area="文献中心" resetKey={libraryScope}><LibraryPage key={libraryScope} collection={libraryScope} booksOnly /></ErrorBoundary></div>}
      <div className={`inventory-pane${showList ? ' mobile-list' : ''}`} style={{ display: inventoryVisible ? 'flex' : 'none' }}>
        {inventoryVisible && <button className="mobile-list-toggle" onClick={() => setShowList(!showList)}>展开 / 收起资料列表</button>}
        {inventoryVisible && <div className="app-body"><Sidebar editable={archiveMaintenance} /><div className="app-main"><ErrorBoundary area="文物档案与全景" resetKey={section}>{section === 'scene' ? <SceneView /> : <LedgerView editable={archiveMaintenance} />}</ErrorBoundary></div></div>}
        <Suspense fallback={null}>{stageVisited.current && <SiteStage />}</Suspense><Lightbox />
      </div>
      {searchVisited.current && <SearchPage active={section === 'search'} query={submitted} submissionId={submissionId} onQuery={q => { setQuery(q); setSubmitted(q); setSubmissionId(id => id + 1) }} onStone={id => { useStore.getState().select(id); navigate('archive') }} onDocument={openDocument} onExtension={(id, pageNo) => { void openExtensionBook(id, pageNo).then(opened => { if (!opened) toast.warn('当前仅有书目记录，尚未收录 PDF 原文') }).catch(toast.error) }} />}
    </main>
    {workspace && <div className="unified-status"><span>{stats ? `${stats.total}件文物 · ${stats.with_model}件三维模型 · 核心10本 · 扩展${stats.books}条` : '正在载入档案…'}</span><span>研究工作台</span></div>}
    {reference && <PublicReference target={reference} onClose={() => setReference(null)} />}
    <Toaster />
  </div>
}
