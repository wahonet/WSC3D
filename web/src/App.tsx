import { useEffect } from 'react'
import ErrorBoundary from './components/ErrorBoundary'
import ResearchPage from './components/research/ResearchPage'
import Toaster from './components/Toaster'
import TopBar from './components/TopBar'
import Workbench from './components/Workbench'
import { useShortcuts } from './hooks/useShortcuts'
import { useApp } from './store/useApp'

export default function App() {
  const page = useApp(s => s.page)
  const curStone = useApp(s => s.curStone)
  const boot = useApp(s => s.boot)

  useEffect(() => { boot() }, [boot])
  useShortcuts(page === 'work')

  return (
    <div className="shell">
      <TopBar />
      {page === 'research' && curStone
        ? <ErrorBoundary area="研究模块"><ResearchPage key={curStone.id} stoneId={curStone.id} /></ErrorBoundary>
        : <Workbench />}
      <Toaster />
    </div>
  )
}
