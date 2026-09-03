import { useMemo } from 'react'
import { X } from 'lucide-react'
import { LEVEL_LABEL, REVIEW_LABEL, REVIEW_TONE } from '../../lib/constants'
import { ancestors, isStructural } from '../../lib/tree'
import { useApp } from '../../store/useApp'
import { Badge, Button } from '../ui'

/** 首页：点选图上节点后浮出的只读信息卡（名称、路径、类别、概念、图像志、释文） */
export default function NodeInfoCard() {
  const stoneAnnos = useApp(s => s.stoneAnnos)
  const concepts = useApp(s => s.concepts)
  const taxonomy = useApp(s => s.taxonomy)
  const selectedId = useApp(s => s.selectedId)
  const select = useApp(s => s.select)
  const byId = useMemo(() => new Map(stoneAnnos.map(a => [a.id, a])), [stoneAnnos])
  const a = selectedId != null ? byId.get(selectedId) : undefined
  if (!a || !isStructural(a)) return null
  const path = ancestors(byId, a)
  const cnames = a.concept_ids.map(id => concepts.find(c => c.id === id)?.name).filter(Boolean) as string[]
  const sem = a.semantics
  const hasSem = sem.pre_iconographic || sem.iconographic || sem.iconological || sem.inscription.transcription

  return (
    <div className="node-card">
      <div className="nc-head">
        <span className="sw" style={{ background: a.color }} />
        <b className="truncate">{a.label}</b>
        <Badge mono outline>{LEVEL_LABEL[a.level] ?? '未定层级'}</Badge>
        <Badge tone={REVIEW_TONE[a.review_status]}>{REVIEW_LABEL[a.review_status]}</Badge>
        <span style={{ flex: 1 }} />
        <Button size="xs" variant="ghost" icon={<X size={12} />} onClick={() => select(null)} />
      </div>
      {path.length > 0 && <div className="nc-path">{path.map(p => p.label).join(' ? ')}</div>}
      {(a.category || cnames.length > 0) && (
        <div className="nc-row">
          {a.category && <Badge tone="blue">{taxonomy?.sop_categories[a.category] ?? a.category}</Badge>}
          {cnames.map(n => <span key={n} className="cchip">{n}</span>)}
        </div>
      )}
      {hasSem && (
        <div className="nc-sem">
          {sem.inscription.transcription && <p><b>录文</b>{sem.inscription.transcription}{sem.inscription.translation && <span className="muted">（{sem.inscription.translation}）</span>}</p>}
          {sem.pre_iconographic && <p><b>描述</b>{sem.pre_iconographic}</p>}
          {sem.iconographic && <p><b>主题</b>{sem.iconographic}</p>}
          {sem.iconological && <p><b>阐释</b>{sem.iconological}</p>}
        </div>
      )}
      {a.desc_text && <div className="nc-text" style={{ borderColor: a.color }}>{a.desc_text}</div>}
      {!hasSem && !a.desc_text && cnames.length === 0 && <div className="hint">尚未填写标注内容——到「标注」模块补齐层级、概念与图像志描述。</div>}
    </div>
  )
}
