import { useEffect } from 'react'
import ErrorBoundary from './components/ErrorBoundary'
import Toaster from './components/Toaster'
import TopBar from './components/TopBar'
import { useShortcuts } from './hooks/useShortcuts'
import AlignPage from './pages/AlignPage'
import AnnotatePage from './pages/AnnotatePage'
import HomePage from './pages/HomePage'
import LibraryPage from './pages/LibraryPage'
import SegmentPage from './pages/SegmentPage'
import { useApp } from './store/useApp'

const PAGES = { home: HomePage, align: AlignPage, segment: SegmentPage, annotate: AnnotatePage, library: LibraryPage }

export default function App() {
  const page = useApp(s => s.page)
  const boot = useApp(s => s.boot)

  useEffect(() => { boot() }, [boot])
  useShortcuts(true)

  const Page = PAGES[page]
  return (
    <div className="shell">
      <TopBar />
      <ErrorBoundary area="页面" resetKey={page}><Page /></ErrorBoundary>
      <Toaster />
    </div>
  )
}
