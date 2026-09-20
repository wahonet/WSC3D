import { useState } from 'react'
import { ArrowLeft, ArrowRight, Eye, EyeOff } from 'lucide-react'
import { useWorkspaceAuth } from '../store/useWorkspaceAuth'

export default function LoginPage({ onLogin, onBack }: { onLogin(): void; onBack(): void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <div className="workspace-login">
    <form className="workspace-login-card" autoComplete="off" onSubmit={async event => {
      event.preventDefault()
      if (busy) return
      setBusy(true); setError('')
      try { await useWorkspaceAuth.getState().login(username, password); setPassword(''); onLogin() }
      catch (reason) { setError((reason as Error).message) }
      finally { setBusy(false) }
    }}>
      <img src="/brand/culture-jining.png" alt="文化济宁" width="48" height="48" />
      <h1>工作台登录</h1>
      <label htmlFor="workspace-username">账号</label>
      <input id="workspace-username" name="workspace-username" value={username} autoComplete="off" autoFocus required
        onChange={event => { setUsername(event.target.value); setError('') }} />
      <label htmlFor="workspace-password">密码</label>
      <div className="workspace-password"><input id="workspace-password" name="workspace-password" type={visible ? 'text' : 'password'} value={password}
        autoComplete="off" required onChange={event => { setPassword(event.target.value); setError('') }} />
        <button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
      </div>
      <p className="workspace-login-error" role="alert">{error}</p>
      <button className="workspace-login-submit" type="submit" disabled={busy}>{busy ? '登录中…' : '登录'} <ArrowRight size={17} /></button>
      <button className="workspace-login-back" type="button" onClick={onBack}><ArrowLeft size={14} />返回展示</button>
    </form>
  </div>
}
