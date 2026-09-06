import { useState } from 'react'
import { BookOpen, Image, Link2, Unlink } from 'lucide-react'
import { deleteAnnotationReference, patchAnnotation } from '../../api'
import { annotationReferences, referenceSource } from '../../lib/references'
import { openAnnotationReference, openReferenceLibrary } from '../../lib/referenceNavigation'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { Annotation, AnnotationReference } from '../../types'
import { Badge, Button } from '../ui'
import './node-references.css'

export default function NodeReferences({ annotation, readOnly = false, initiallyOpen = true }: {
  annotation: Annotation; readOnly?: boolean; initiallyOpen?: boolean
}) {
  const refs = annotationReferences(annotation)
  const [busy, setBusy] = useState<number | null>(null)
  const remove = async (r: AnnotationReference) => {
    if (busy != null) return
    setBusy(r.id)
    try {
      if (r.id < 0) await patchAnnotation(annotation.id, { clear_link: true })
      else await deleteAnnotationReference(annotation.id, r.id)
      await useApp.getState().refreshAnnos()
      toast.ok('已解除这一条关联')
    } catch (e) { toast.error(e) } finally { setBusy(null) }
  }
  return (
    <details className="node-references" open={initiallyOpen}>
      <summary><Link2 size={12} />文献与图像 <span className="muted">{refs.length} 条</span></summary>
      {!readOnly && <div className="node-ref-add">
        <span className="hint">可关联多本文献、多个文段和插图</span>
        <Button size="xs" onClick={openReferenceLibrary} icon={<BookOpen size={12} />}>去书库添加</Button>
      </div>}
      {refs.length === 0 && <div className="hint">暂无关联。可在文献模块选取释文，或到书库关联文段和插图。</div>}
      <div className="node-ref-list">
        {refs.map(r => (
          <article className="node-ref" key={r.id}>
            <div className="node-ref-head">
              <Badge tone={r.kind === 'figure' ? 'violet' : 'blue'}>{r.kind === 'figure' ? '插图' : r.kind === 'segment' ? '文段' : '释文'}</Badge>
              <span className="node-ref-source" title={referenceSource(r)}>{referenceSource(r)}</span>
            </div>
            <div className="node-ref-content">
              {r.kind === 'figure' && r.image_url && <img className="node-ref-thumb" src={r.image_url} loading="lazy" alt={r.figure_label || '关联插图'} />}
              <div>
                {r.figure_label && <b>{r.figure_label}</b>}
                <details className="node-ref-quote"><summary>{r.text || (r.kind === 'figure' ? '（无图注）' : '（无文字）')}</summary>
                  <p>{r.text || '（无文字）'}</p>
                </details>
              </div>
            </div>
            <div className="node-ref-actions">
              {r.source_missing && <span className="hint">原始条目已变更，保留引用摘录</span>}
              <Button size="xs" variant="ghost" icon={r.kind === 'figure' ? <Image size={12} /> : <BookOpen size={12} />}
                disabled={r.kind !== 'description' && r.page_id == null} onClick={() => openAnnotationReference(r)}>
                {r.kind === 'description' ? '定位释文' : '查看原页'}
              </Button>
              {!readOnly && <Button size="xs" variant="ghost" icon={<Unlink size={12} />}
                disabled={busy != null} onClick={() => remove(r)} aria-label={`解除${r.kind === 'figure' ? '插图' : '文段'}关联 ${r.id}`}>
                {busy === r.id ? '解除中…' : '解除'}
              </Button>}
            </div>
          </article>
        ))}
      </div>
    </details>
  )
}
