import { ChevronRight, ExternalLink, Moon, RefreshCw, Sun } from 'lucide-react'
import { PAGES } from '../lib/constants'
import { useApp } from '../store/useApp'
import { Badge, Button } from './ui'

/** 顶栏：品牌 · 流水线导航（首页 / 1 对齐 / 2 分割 / 3 标注 / 4 文献）· 面包屑 · 系统按钮 */
export default function TopBar() {
  const page = useApp(s => s.page)
  const setPage = useApp(s => s.setPage)
  const curStone = useApp(s => s.curStone)
  const curAsset = useApp(s => s.curAsset)
  const theme = useApp(s => s.theme)
  const toggleTheme = useApp(s => s.toggleTheme)
  const rescan = useApp(s => s.rescan)
  const backendOk = useApp(s => s.backendOk)
  const stats = useApp(s => s.stats)

  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark">石</span>
        Stone<em>Lab</em>
        <small>汉画像石研究平台</small>
      </div>

      <nav className="pipeline" aria-label="工作流水线">
        {PAGES.map((p, i) => (
          <span key={p.id} className="pl-item">
            {i === 1 && <span className="pl-gap" />}
            {i > 1 && <ChevronRight size={12} className="pl-arrow" />}
            <button className={`pl-btn${page === p.id ? ' on' : ''}${p.step ? ' step' : ''}`} onClick={() => setPage(p.id)} title={p.desc}>
              {p.step != null && <span className="pl-num">{p.step}</span>}
              {p.label}
            </button>
          </span>
        ))}
      </nav>

      <div className="crumb">
        {curStone ? (
          <>
            <b>{curStone.name}</b>
            <span className="mono muted">{curStone.code}</span>
            {curAsset && (
              <>
                <ChevronRight size={13} className="sep" />
                <span className="truncate" style={{ maxWidth: 220 }}>{curAsset.filename}</span>
                {curAsset.is_master && <Badge tone="accent">主图</Badge>}
              </>
            )}
          </>
        ) : <span className="muted">未选择画像石</span>}
      </div>

      <span className="spacer" />

      <div className="right">
        <span className={`status-pill${backendOk ? '' : ' bad'}`} title="后端 127.0.0.1:8020 · SQLite">
          <span className="dot" />
          {backendOk ? `本机 · SQLite${stats ? ` · v${stats.version}` : ''}` : '后端未连接'}
        </span>
        <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={rescan} title="重新扫描 assets/stones（新素材入库）">
          重新扫描
        </Button>
        <Button variant="ghost" size="sm" icon={<ExternalLink size={14} />} title="接口文档 (OpenAPI)"
          onClick={() => window.open('http://127.0.0.1:8020/docs', '_blank')} />
        <Button variant="ghost" size="sm" icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          onClick={toggleTheme} title={theme === 'dark' ? '切换到浅色' : '切换到深色'} />
      </div>
    </header>
  )
}
