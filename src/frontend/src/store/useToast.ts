import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error' | 'warn'
export interface Toast { id: number; kind: ToastKind; text: string }

interface ToastState {
  toasts: Toast[]
  push: (kind: ToastKind, text: string, ttl?: number) => void
  dismiss: (id: number) => void
  /** 鼠标悬停或键盘聚焦时暂停自动关闭，便于读完较长的错误说明 */
  hold: (id: number) => void
  release: (id: number) => void
}

let seq = 1
const timers = new Map<number, number>()
const RESUME_MS = 2500

function schedule(id: number, ms: number) {
  window.clearTimeout(timers.get(id))
  timers.set(id, window.setTimeout(() => useToast.getState().dismiss(id), ms))
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text, ttl) => {
    const id = seq++
    const kept = get().toasts.slice(-4)
    get().toasts.filter(t => !kept.includes(t)).forEach(t => { window.clearTimeout(timers.get(t.id)); timers.delete(t.id) })
    set({ toasts: [...kept, { id, kind, text }] })
    schedule(id, ttl ?? (kind === 'error' ? 6500 : 3200))
  },
  dismiss: id => {
    window.clearTimeout(timers.get(id)); timers.delete(id)
    set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }))
  },
  hold: id => { window.clearTimeout(timers.get(id)); timers.delete(id) },
  release: id => { if (get().toasts.some(t => t.id === id)) schedule(id, RESUME_MS) },
}))

export const toast = {
  info: (t: string) => useToast.getState().push('info', t),
  ok: (t: string) => useToast.getState().push('success', t),
  warn: (t: string) => useToast.getState().push('warn', t),
  error: (t: unknown) => useToast.getState().push('error', t instanceof Error ? t.message : String(t)),
}
