import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error' | 'warn'
export interface Toast { id: number; kind: ToastKind; text: string }

interface ToastState {
  toasts: Toast[]
  push: (kind: ToastKind, text: string, ttl?: number) => void
  dismiss: (id: number) => void
}

let seq = 1

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text, ttl) => {
    const id = seq++
    set(s => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }))
    window.setTimeout(() => get().dismiss(id), ttl ?? (kind === 'error' ? 6500 : 3200))
  },
  dismiss: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
}))

export const toast = {
  info: (t: string) => useToast.getState().push('info', t),
  ok: (t: string) => useToast.getState().push('success', t),
  warn: (t: string) => useToast.getState().push('warn', t),
  error: (t: unknown) => useToast.getState().push('error', t instanceof Error ? t.message : String(t)),
}
