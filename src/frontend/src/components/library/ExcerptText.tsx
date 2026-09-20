import { useEffect, useRef, useState } from 'react'
import type { ReferenceExcerpt } from '../../types'
import './node-references.css'

type Selection = Omit<ReferenceExcerpt, 'field'>

export default function ExcerptText({ text, onPick, disabled = false }: {
  text: string; onPick?: (excerpt: ReferenceExcerpt) => void; disabled?: boolean
}) {
  const content = useRef<HTMLParagraphElement>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  useEffect(() => { setSelection(null) }, [text])
  const capture = () => {
    const root = content.current, selected = window.getSelection()
    if (!onPick || disabled || !root || !selected?.rangeCount || selected.isCollapsed) { setSelection(null); return }
    const range = selected.getRangeAt(0)
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) { setSelection(null); return }
    const before = range.cloneRange()
    before.selectNodeContents(root)
    before.setEnd(range.startContainer, range.startOffset)
    // API 使用 Unicode 字符位置；不能把罕见汉字的 UTF-16 双码元算成两个字。
    const start = Array.from(before.toString()).length
    const chosen = range.toString()
    setSelection(chosen.trim() ? { start, end: start + Array.from(chosen).length, text: chosen } : null)
  }
  const pick = (field: ReferenceExcerpt['field']) => {
    if (!selection || !onPick) return
    onPick({ ...selection, field })
    setSelection(null)
  }
  return <div className="excerpt-text">
    <p ref={content} onMouseUp={capture} onKeyUp={capture} onTouchEnd={capture}>{text}</p>
    {selection && !disabled && <div className="excerpt-actions" onMouseDown={e => e.preventDefault()}>
      <button type="button" className="btn xs" onClick={() => pick('pre_iconographic')}>填入直观描述</button>
      <button type="button" className="btn xs" onClick={() => pick('iconographic')}>填入故事描述</button>
    </div>}
  </div>
}
