import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useToast } from '../store/useToast'

const ICON = {
  info: <Info size={15} />,
  success: <CheckCircle2 size={15} />,
  warn: <AlertTriangle size={15} />,
  error: <XCircle size={15} />,
}

/**
 * 提示容器始终存在并作为 polite 播报区域，读屏软件才能可靠读出后加入的提示；
 * 错误提示单独用 alert 立即播报。悬停或聚焦时暂停自动关闭。
 */
export default function Toaster() {
  const toasts = useToast(s => s.toasts)
  const { dismiss, hold, release } = useToast.getState()
  return (
    <div className="toaster" aria-live="polite" aria-relevant="additions">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}
          onMouseEnter={() => hold(t.id)} onMouseLeave={() => release(t.id)}
          onFocus={() => hold(t.id)} onBlur={() => release(t.id)}>
          {ICON[t.kind]}
          <span>{t.text}</span>
          <button className="x" onClick={() => dismiss(t.id)} aria-label="关闭提示"><X size={13} /></button>
        </div>
      ))}
    </div>
  )
}
