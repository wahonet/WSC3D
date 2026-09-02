import { useEffect } from 'react'
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
        ? <ResearchPage key={curStone.id} stoneId={curStone.id} />
        : <Workbench />}
      <Toaster />
    </div>
  )
}
