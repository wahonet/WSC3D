import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useApp } from '../../store/useApp'
import type { Concept } from '../../types'

/** 分类 id -> "大类 · 小类" 路径名 */
export function useCategoryPath() {
  const taxonomy = useApp(s => s.taxonomy)
  return useMemo(() => {
    const m = new Map((taxonomy?.categories ?? []).map(c => [c.id, c]))
    return (id: string) => {
      const c = m.get(id)
      if (!c) return id || '未分类'
      const p = c.parent_id ? m.get(c.parent_id) : null
      return p ? `${p.name} · ${c.name}` : c.name
    }
  }, [taxonomy])
}

/**
 * 概念选择器：已挂概念为可删的芯片；输入即搜索（名称 / 别名），回车挂第一项；
 * 没有匹配时可现场新增（选一个末级分类）。
 */
export default function ConceptPicker({ value, onChange, defaultCategory }: {
  value: number[]
  onChange: (ids: number[]) => void
  /** 新增概念时的默认分类 */
  defaultCategory?: string
}) {
  const concepts = useApp(s => s.concepts)
  const taxonomy = useApp(s => s.taxonomy)
  const addConcept = useApp(s => s.addConcept)
  const catPath = useCategoryPath()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [newCat, setNewCat] = useState(defaultCategory || 'cat-person-figure')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (defaultCategory) setNewCat(defaultCategory) }, [defaultCategory])
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const byId = useMemo(() => new Map(concepts.map(c => [c.id, c])), [concepts])
  const chosen = value.map(id => byId.get(id)).filter((c): c is Concept => !!c)
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase()
    const pool = concepts.filter(c => !value.includes(c.id))
    if (!s) return pool.slice().sort((a, b) => b.usage - a.usage).slice(0, 12)
    const score = (c: Concept) => {
      const n = c.name.toLowerCase()
      if (n === s) return 0
      if (n.startsWith(s)) return 1
      if (n.includes(s)) return 2
      if (c.aliases.some(a => a.toLowerCase().includes(s))) return 3
      return 9
    }
    return pool.map(c => [score(c), c] as const).filter(([sc]) => sc < 9)
      .sort((a, b) => a[0] - b[0] || b[1].usage - a[1].usage).slice(0, 14).map(([, c]) => c)
  }, [concepts, q, value])
  const exact = concepts.some(c => c.name === q.trim())
  const leafCats = (taxonomy?.categories ?? []).filter(c => c.parent_id)

  const add = (c: Concept) => { onChange([...value, c.id]); setQ(''); setOpen(false) }
  const createNew = async () => {
    const name = q.trim()
    if (!name) return
    const c = await addConcept(name, newCat)
    if (c) add(c)
  }

  return (
    <div className="cpick" ref={boxRef}>
      <div className="cpick-chips">
        {chosen.map(c => (
          <span key={c.id} className="cchip" title={`${catPath(c.category_id)}${c.description ? `\n${c.description}` : ''}`}>
            {c.name}
            <button onClick={() => onChange(value.filter(i => i !== c.id))} aria-label="移除"><X size={10} /></button>
          </span>
        ))}
        <input className="cpick-input" placeholder={chosen.length ? '再加一个…' : '搜索概念，回车挂接'} value={q}
          onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true) }}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (hits.length > 0) add(hits[0])
              else if (q.trim() && !exact) createNew()
            }
            if (e.key === 'Escape') { setOpen(false); setQ('') }
          }} />
      </div>
      {open && (hits.length > 0 || q.trim()) && (
        <div className="cpick-menu">
          {hits.map(c => (
            <button key={c.id} className="cpick-item" onMouseDown={e => e.preventDefault()} onClick={() => add(c)}>
              <span className="n">{c.name}</span>
              {c.aliases.length > 0 && <span className="al">{c.aliases.slice(0, 3).join(' / ')}</span>}
              <span className="cat">{catPath(c.category_id)}</span>
              {c.usage > 0 && <span className="u">{c.usage}</span>}
            </button>
          ))}
          {q.trim() && !exact && (
            <div className="cpick-new">
              <Plus size={12} />
              <span>新增「<b>{q.trim()}</b>」到</span>
              <select className="select sm" value={newCat} onChange={e => setNewCat(e.target.value)}>
                {leafCats.map(c => <option key={c.id} value={c.id}>{catPath(c.id)}</option>)}
              </select>
              <button className="btn xs primary" onMouseDown={e => e.preventDefault()} onClick={createNew}>新增并挂接</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
