import { useEffect, useState } from 'react'
import { Check, KeyRound, LoaderCircle, Save, Video, ImagePlus } from 'lucide-react'
import SeedreamSettings from '../components/SeedreamSettings'
import { api } from '../archive/api'
import type { LlmProfile, LlmSettings } from '../archive/types'
import { VIDEO_POLICY } from '../lib/sections'
import { goToSection } from '../lib/navigation'

type Provider = 'deepseek' | 'custom' | 'seedream'
export default function ApiConfigPage() {
  const [settings, setSettings] = useState<LlmSettings | null>(null)
  const [active, setActive] = useState<Provider>('deepseek')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    let current = true
    api.llmSettings().then(value => { if (current) setSettings(value) }).catch(reason => { if (current) { setError(true); setMessage(reason.message) } })
    return () => { current = false }
  }, [])
  const profile = settings?.profiles[active]
  const patch = (value: Partial<LlmProfile>) => {
    setMessage('')
    setSettings(previous => previous && ({ ...previous, profiles: { ...previous.profiles, [active]: { ...previous.profiles[active], ...value } } }))
  }
  const save = async () => {
    if (!settings || !profile || busy) return
    setBusy(true); setMessage(''); setError(false)
    try {
      const saved = await api.saveLlm({
        ...(active === 'deepseek' ? { mode: settings.mode, provider: 'deepseek' } : {}),
        profiles: { [active]: { api_base: profile.api_base, model: active === 'custom' ? VIDEO_POLICY.model : profile.model,
          api_key: profile.api_key || '', clear_key: !!profile.clear_key } },
      })
      setSettings(previous => previous && ({ ...saved, local: previous.local,
        profiles: { ...previous.profiles, [active]: saved.profiles[active] } }))
      setMessage('已保存')
    } catch (reason) { setError(true); setMessage((reason as Error).message) }
    finally { setBusy(false) }
  }
  return <div className="api-config-page"><div className="api-config-inner">
    <h1>API配置</h1>
    <div className="api-provider-tabs" role="tablist" aria-label="API服务">
      <button role="tab" aria-selected={active === 'deepseek'} disabled={busy} onClick={() => { setActive('deepseek'); setMessage('') }}><KeyRound size={17} /><span>DeepSeek<small>AI问答</small></span></button>
      <button role="tab" aria-selected={active === 'custom'} disabled={busy} onClick={() => { setActive('custom'); setMessage('') }}><Video size={17} /><span>MiniMax<small>动态演绎</small></span></button>
      <button role="tab" aria-selected={active === 'seedream'} disabled={busy} onClick={() => { setActive('seedream'); setMessage('') }}><ImagePlus size={17} /><span>Seedream<small>文创生图</small></span></button>
    </div>
    {active === 'seedream' ? <SeedreamSettings /> : !settings || !profile ? <p role="status">{message || '读取配置…'}</p> : <form className="api-config-form" autoComplete="off" onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={busy}>
        {active === 'deepseek' && <label>问答方式<select value={settings.mode} onChange={event => setSettings({ ...settings, mode: event.target.value as LlmSettings['mode'] })}>
          <option value="online_first">DeepSeek 优先，本地模型兜底</option><option value="local_only">仅使用本地模型</option>
        </select></label>}
        <label>API地址<input spellCheck={false} value={profile.api_base} onChange={event => patch({ api_base: event.target.value, api_key: '', clear_key: true })} /></label>
        <label>模型<input spellCheck={false} list={active === 'deepseek' ? 'deepseek-models' : undefined} readOnly={active === 'custom'} value={active === 'custom' ? 'MiniMax-H3 / MiniMax-H3-Max' : profile.model || ''} onChange={event => patch({ model: event.target.value })} /></label>
        <datalist id="deepseek-models">{settings.profiles.deepseek.models.map(model => <option key={model} value={model} />)}</datalist>
        <label>API Key<input type="password" name={`${active}-api-key`} autoComplete="new-password" spellCheck={false} value={profile.api_key || ''}
          placeholder={profile.has_key && !profile.clear_key ? '已保存；留空保留' : '填写 API Key'} onChange={event => patch({ api_key: event.target.value })} /></label>
        <div className="api-config-key"><span>{profile.clear_key || profile.api_key ? '密钥修改未保存' : profile.has_key ? <><Check size={13} />已在本机加密保存</> : '未配置'}</span>
          {profile.has_key && !profile.clear_key && <button type="button" onClick={() => patch({ clear_key: true, api_key: '' })}>移除密钥</button>}</div>
        {active === 'deepseek' ? <div className="api-config-summary"><span>本地模型</span><strong>{settings.local.model || '未配置'}</strong></div>
          : <div className="api-video-policy"><div><span>多模态生成</span><strong>H3 · 768p</strong></div><div><span>极速生成</span><strong>H3 Max · 480p</strong></div><div><span>每次生成</span><strong>{VIDEO_POLICY.outputs} 条 · 默认 5 秒</strong></div><p><button type="button" className="api-video-link" onClick={() => goToSection('video', { creative_tab: 'video' })}>视频生成 →</button></p></div>}
      </fieldset>
      <div className="api-config-footer"><span role="status" className={error ? 'error' : ''}>{busy ? '保存中…' : message}</span><button type="submit" disabled={busy}>{busy ? <LoaderCircle size={15} /> : <Save size={15} />}保存配置</button></div>
    </form>}
  </div></div>
}
