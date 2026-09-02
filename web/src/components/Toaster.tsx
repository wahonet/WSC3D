import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useToast } from '../store/useToast'

const ICON = {
  info: <Info size={15} />,
  success: <CheckCircle2 size={15} />,
  warn: <AlertTriangle size={15} />,
  error: <XCircle size={15} />,
}

export default function Toaster() {
  const toasts = useToast(s => s.toasts)
  const dismiss = useToast(s => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="toaster">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          {ICON[t.kind]}
          <span>{t.text}</span>
          <button className="x" onClick={() => dismiss(t.id)} aria-label="dismiss"><X size={13} /></button>
        </div>
      ))}
    </div>
  )
}
