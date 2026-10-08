import { create } from 'zustand'

export const useWorkspaceAuth = create<{
  authenticated: boolean
  /** 启动时的会话检查尚未返回 */
  checking: boolean
  checkSession(): Promise<void>
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
}>((set) => ({
  authenticated: false,
  checking: true,
  async checkSession() {
    try {
      const response = await fetch('/api/workspace/session', { cache: 'no-store' })
      set({ authenticated: response.ok && (await response.json()).authenticated === true, checking: false })
    } catch { set({ authenticated: false, checking: false }) }
  },
  async login(username, password) {
    const response = await fetch('/api/workspace/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    })
    if (!response.ok) {
      const detail = response.status === 429 ? (await response.json().catch(() => null))?.detail : null
      throw new Error(typeof detail === 'string' ? detail : response.status === 401 ? '账号或密码不正确' : '登录失败，请稍后重试')
    }
    set({ authenticated: true, checking: false })
  },
  async logout() {
    const response = await fetch('/api/workspace/logout', { method: 'POST' })
    if (!response.ok) throw new Error('退出失败，请稍后重试')
    set({ authenticated: false, checking: false })
  },
}))
