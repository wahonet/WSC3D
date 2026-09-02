import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

type Size = 'md' | 'sm' | 'xs'
type Variant = 'default' | 'primary' | 'ghost' | 'danger'

export function Button({ variant = 'default', size = 'md', icon, block, className = '', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant; size?: Size; icon?: ReactNode; block?: boolean
  }) {
  const cls = ['btn', variant !== 'default' ? variant : '', size !== 'md' ? size : '',
    !children && icon ? 'icon' : '', block ? 'block' : '', className].filter(Boolean).join(' ')
  return <button type="button" className={cls} {...rest}>{icon}{children}</button>
}

export function Chip({ on, size, className = '', children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean; size?: 'sm' }) {
  return (
    <button type="button" className={`chip${on ? ' on' : ''}${size ? ` ${size}` : ''} ${className}`} {...rest}>
      {children}
    </button>
  )
}

export function Badge({ tone, mono, outline, title, children }: {
  tone?: 'accent' | 'green' | 'amber' | 'blue' | 'violet' | 'cyan' | 'red'; mono?: boolean; outline?: boolean
  title?: string; children: ReactNode
}) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ''}${mono ? ' mono' : ''}${outline ? ' outline' : ''}`} title={title}>
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>
}

export function Switch({ checked, onChange, disabled, children }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: ReactNode
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="track" />
      {children && <span>{children}</span>}
    </label>
  )
}

export function Range(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="range" className="range" {...props} />
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      {title && <b>{title}</b>}
      {children && <div>{children}</div>}
    </div>
  )
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />
}

export function Field({ label, row, children }: { label: string; row?: boolean; children: ReactNode }) {
  return (
    <div className={`field${row ? ' row' : ''}`}>
      <label>{label}</label>
      {children}
    </div>
  )
}

export function Note({ tone, children }: { tone?: 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`note-box${tone ? ` ${tone}` : ''}`}>{children}</div>
}
