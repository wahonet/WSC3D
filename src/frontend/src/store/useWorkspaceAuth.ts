import { create } from 'zustand'

export const useWorkspaceAuth = create<{
  authenticated: boolean
  checkSession(): Promise<void>
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
}>((set) => ({
  authenticated: false,
  async checkSession() {
    try {
      const response = await fetch('/api/workspace/session', { cache: 'no-store' })
      set({ authenticated: response.ok && (await response.json()).authenticated === true })
    } catch { set({ authenticated: false }) }
  },
  async login(username, password) {
    const response = await fetch('/api/workspace/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    })
    if (!response.ok) throw new Error(response.status === 401 ? '账号或密码不正确' : '登录失败，请稍后重试')
    set({ authenticated: true })
  },
  async logout() {
    const response = await fetch('/api/workspace/logout', { method: 'POST' })
    if (!response.ok) throw new Error('退出失败，请稍后重试')
    set({ authenticated: false })
  },
}))
