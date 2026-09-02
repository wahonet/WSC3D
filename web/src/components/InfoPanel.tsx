import { BookOpen, ChevronRight, Landmark } from 'lucide-react'
import { useApp } from '../store/useApp'
import { Button, Empty } from './ui'

export default function InfoPanel() {
  const info = useApp(s => s.stoneInfo)
  const setPage = useApp(s => s.setPage)

  if (!info) return <Empty icon={<Landmark size={22} />} title="未选择画像石">在左侧列表中打开任意素材，这里显示该石的简介与释文</Empty>

  return (
    <div className="info">
      <div className="info-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{info.name}</h2>
          <div className="code">{info.code} · {info.asset_count} 件素材 · {info.annotation_count} 条标注</div>
        </div>
        <Button size="sm" icon={<BookOpen size={13} />} onClick={() => setPage('research')} title="进入研究模块：编辑信息、图文关联">
          研究
        </Button>
      </div>

      <dl className="meta-grid">
        <dt>尺寸</dt><dd>{info.dims_text || <span className="muted">—</span>}</dd>
        <dt>年代</dt><dd>{info.era || <span className="muted">—</span>}</dd>
        <dt>材质</dt><dd>{info.material || <span className="muted">—</span>}</dd>
        <dt>刻法</dt><dd>{info.carving || <span className="muted">—</span>}</dd>
        <dt>收藏</dt><dd>{info.location || <span className="muted">—</span>}</dd>
      </dl>

      {info.description && <div className="prose">{info.description}</div>}

      {info.layers.length > 0 && (
        <div className="layer-list">
          {info.layers.map((l, i) => (
            <details className="layer-item" key={l.seq} open={i === 0}>
              <summary>
                <span className="seq">{l.seq}</span>
                <span className="truncate">{l.name}</span>
                <ChevronRight size={13} className="chev" />
              </summary>
              <div className="body prose">{l.summary || <span className="muted">（暂无释文）</span>}</div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
