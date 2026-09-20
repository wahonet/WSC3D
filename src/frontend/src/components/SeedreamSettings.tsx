import { useEffect, useState } from 'react'
import { Check, Save } from 'lucide-react'
import { creativeApi, type ImageSettings } from '../lib/creativeApi'

export default function SeedreamSettings() {
  const [settings, setSettings] = useState<ImageSettings | null>(null), [key, setKey] = useState(''), [clear, setClear] = useState(false)
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { creativeApi.imageSettings().then(setSettings).catch(reason => setMessage(reason.message)) }, [])
  const save = async () => { setBusy(true); setMessage(''); try { setSettings(await creativeApi.saveImageSettings(key, clear)); setKey(''); setClear(false); setMessage('已保存') } catch (reason) { setMessage((reason as Error).message) } finally { setBusy(false) } }
  return <form className="api-config-form" autoComplete="off" onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={busy}>
    <label>API地址<input readOnly value={settings?.api_base || 'https://ark.cn-beijing.volces.com/api/v3'} /></label><label>模型<input readOnly value={settings?.model || 'doubao-seedream-5-0-260128'} /></label>
    <label>API Key<input type="password" autoComplete="new-password" value={key} placeholder={settings?.has_key && !clear ? '已保存；留空保留' : '填写火山方舟 API Key'} onChange={event => setKey(event.target.value)} /></label>
    <div className="api-config-key"><span>{settings?.has_key && !clear ? <><Check size={13} />已在本机加密保存</> : '未配置'}</span>{settings?.has_key && !clear && <button type="button" onClick={() => { setClear(true); setKey('') }}>移除密钥</button>}</div>
    <div className="api-config-summary"><span>每次生成</span><strong>1 张 · 2K · 约 ¥{settings?.price_per_image.toFixed(2) || '0.22'}</strong></div>
  </fieldset><div className="api-config-footer"><span role="status">{message}</span><button type="submit" disabled={busy}><Save size={15} />保存配置</button></div></form>
}
