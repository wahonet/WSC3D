import { useEffect, useState } from 'react'
import { Check, Download, LoaderCircle, Plus, Printer, RotateCw, Save, X } from 'lucide-react'
import { studioApi, type AdminTheme, type AdminVenue, type PrintTicket, type Stats, type Venue } from '../../lib/creativeApi'
import AnnotationSourcePicker, { emptySelection, type AnnotationSelection } from '../../components/AnnotationSourcePicker'
import { useEscape } from '../../hooks/useEscape'

export function ThemeList({ onOpen }: { onOpen: (id: string) => void }) {
  const [themes, setThemes] = useState<AdminTheme[] | null>(null), [error, setError] = useState(''), [creating, setCreating] = useState(false)
  useEffect(() => { studioApi.themes().then(setThemes).catch(reason => setError(reason.message)) }, [])
  return <div className="cs-body">
    <div className="cs-heading"><div><h1>主题制作</h1><p className="cs-hint">一个主题 = 一块原石上的一个故事：原图 → 线描 → 演绎 → 文案 → 成品 → 上架。每一步都要人工核对，观众端从不调用在线模型。</p></div>
      <button className="cs-primary" onClick={() => setCreating(true)}><Plus size={16} />新建主题</button></div>
    {themes ? themes.length ? <div className="cs-theme-cards">{[...themes].sort((a, b) => a.order - b.order).map(t => { const done = t.steps.filter(s => s.done && !s.optional).length, total = t.steps.filter(s => !s.optional).length; return <button key={t.id} className="cs-theme-card" onClick={() => onOpen(t.id)}>
      <span className="cs-theme-cover">{t.cover_url ? <img src={t.cover_url} alt="" /> : <em>尚无封面</em>}</span>
      <span className="cs-theme-meta"><span><strong>{t.title}</strong><i className={'cs-status ' + t.status}>{t.status === 'published' ? '已上架' : '制作中'}</i></span>
        <small>{t.stone_id} · {t.stone_name}{t.hall ? ' · ' + t.hall.name : ''}</small>
        <span className="cs-progress"><span style={{ width: done / total * 100 + '%' }} /></span>
        <small>{done}/{total} 步 · {t.steps.find(s => !s.done && !s.optional)?.title ? '下一步：' + t.steps.find(s => !s.done && !s.optional)!.title : '全部完成'}</small></span>
    </button> })}</div> : <div className="cs-empty">还没有主题，从一组已审核的结构标注开始</div> : <div className="cs-empty">{error || <LoaderCircle className="cs-spin" size={22} />}</div>}
    {creating && <CreateTheme onClose={() => setCreating(false)} onCreated={theme => onOpen(theme.id)} />}
  </div>
}

function CreateTheme({ onClose, onCreated }: { onClose: () => void; onCreated: (theme: AdminTheme) => void }) {
  const [id, setId] = useState(''), [title, setTitle] = useState(''), [subject, setSubject] = useState('')
  const [selection, setSelection] = useState<AnnotationSelection>(emptySelection), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEscape(() => { if (!busy) onClose() }, true)
  const valid = /^[a-z0-9-]{2,40}$/.test(id) && title.trim().length >= 2 && selection.annotation_ids.length > 0
  const create = async () => {
    setBusy(true); setError('')
    try { onCreated(await studioApi.create({ id, title: title.trim(), subject: subject.trim(), annotation_ids: selection.annotation_ids })) }
    catch (reason) { setError((reason as Error).message); setBusy(false) }
  }
  return <div className="cs-backdrop" onClick={() => { if (!busy) onClose() }}><section className="cs-dialog is-wide" role="dialog" aria-modal="true" aria-label="新建主题" onClick={event => event.stopPropagation()}>
    <header><h2>新建主题</h2><button className="cs-icon" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="cs-create">
      <div className="cs-form">
        <label className="cs-field"><span>主题名<small>2–18 字</small></span><input maxLength={18} value={title} autoFocus onChange={event => setTitle(event.target.value)} placeholder="例如：荆轲刺秦王" /></label>
        <label className="cs-field"><span>编号<small>小写字母、数字和连字符，用在网址里，创建后不能改</small></span><input maxLength={40} value={id} onChange={event => setId(event.target.value.toLowerCase())} placeholder="例如：jingke" /></label>
        <label className="cs-field"><span>画面描述<small>可以之后再写</small></span><textarea rows={4} maxLength={600} value={subject} onChange={event => setSubject(event.target.value)} placeholder="画面里有谁、在做什么、有哪些器物" /></label>
        {error && <p className="cs-error" role="alert">{error}</p>}
        <button className="cs-primary" disabled={busy || !valid} onClick={() => void create()}>{busy ? <LoaderCircle className="cs-spin" size={15} /> : <Plus size={15} />}创建</button>
      </div>
      <AnnotationSourcePicker value={selection} onChange={setSelection} disabled={busy} />
    </div>
  </section></div>
}

// An auto-detected address stays automatic unless someone types one in.
const editable = (value: AdminVenue) => ({ ...value, base_url: value.auto_base_url ? '' : value.base_url })
const SCREENS = [['kiosk', '自助屏', '触摸一体机，观众自己浏览、定制', 'kiosk=1'], ['screen', '展示大屏', '无人触摸，自动轮播主题和二维码', 'screen=1']] as const
const EVENTS: [string, string][] = [['view', '浏览故事'], ['download', '保存成品'], ['work', '定制作品'], ['handoff', '扫码带走'], ['print', '打印'], ['stamp', '盖章'], ['complete', '集齐七章']]

export function VenuePanel({ halls }: { halls: Venue['halls'] }) {
  const [venue, setVenue] = useState<AdminVenue | null>(null), [form, setForm] = useState<AdminVenue | null>(null)
  const [prints, setPrints] = useState<PrintTicket[]>([]), [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
  const loadPrints = () => studioApi.prints().then(setPrints).catch(() => undefined)
  useEffect(() => {
    studioApi.venue().then(value => { setVenue(value); setForm(editable(value)) }).catch(reason => setError(reason.message))
    studioApi.stats(30).then(setStats).catch(() => undefined)
    void loadPrints()
    const timer = window.setInterval(() => void loadPrints(), 15000)
    return () => window.clearInterval(timer)
  }, [])
  const save = async () => {
    if (!form) return
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await studioApi.saveVenue({ base_url: form.base_url.trim(), idle_seconds: form.idle_seconds, wifi_ssid: form.wifi_ssid.trim(), wifi_password: form.wifi_password, wifi_security: form.wifi_security, print_enabled: form.print_enabled })
      setVenue(value); setForm(editable(value)); setNotice('已保存。地址或 Wi-Fi 改动后，请重新下载并打印海报；地址改动后还要重新下载屏幕启动脚本。')
    } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }
  const mark = async (ticket: PrintTicket, status: PrintTicket['status']) => {
    try { await studioApi.markPrint(ticket.id, status); await loadPrints() } catch (reason) { setError((reason as Error).message) }
  }
  const queued = prints.filter(p => p.status === 'queued')
  return <div className="cs-body cs-venue">
    <div className="cs-heading"><div><h1>场馆与现场</h1><p className="cs-hint">观众只在传承中心的局域网内访问。这里设置访问地址、Wi-Fi、自助屏和打印，下载展厅海报，查看现场数据。</p></div></div>
    {error && <p className="cs-error" role="alert">{error}<button aria-label="关闭" onClick={() => setError('')}><X size={14} /></button></p>}
    {notice && <p className="cs-notice" role="status"><Check size={15} />{notice}</p>}
    <div className="cs-venue-grid">
      <section className="cs-card">
        <h2>访问与自助屏</h2>
        {form ? <div className="cs-form">
          <label className="cs-field"><span>访问地址<small>{venue?.auto_base_url ? `留空时自动使用本机局域网地址：${venue.base_url}` : '二维码里的地址，观众手机须能打开'}</small></span>
            <input value={form.base_url} placeholder={venue?.base_url} onChange={event => setForm({ ...form, base_url: event.target.value })} /></label>
          <label className="cs-field"><span>自助屏无人操作回到首页<small>30–600 秒</small></span><input type="number" min={30} max={600} value={form.idle_seconds} onChange={event => setForm({ ...form, idle_seconds: Number(event.target.value) || 90 })} /></label>
          <div className="cs-row">
            <label className="cs-field"><span>访客 Wi-Fi 名称</span><input maxLength={32} value={form.wifi_ssid} onChange={event => setForm({ ...form, wifi_ssid: event.target.value })} /></label>
            <label className="cs-field"><span>加密</span><select value={form.wifi_security} onChange={event => setForm({ ...form, wifi_security: event.target.value as AdminVenue['wifi_security'] })}><option value="WPA">WPA/WPA2</option><option value="WEP">WEP</option><option value="nopass">无密码</option></select></label>
          </div>
          {form.wifi_security !== 'nopass' && <label className="cs-field"><span>Wi-Fi 密码<small>印在海报的 Wi-Fi 二维码里</small></span><input maxLength={63} value={form.wifi_password} onChange={event => setForm({ ...form, wifi_password: event.target.value })} /></label>}
          <label className="cs-check"><input type="checkbox" checked={form.print_enabled} onChange={event => setForm({ ...form, print_enabled: event.target.checked })} />开放打印（明信片与表情贴纸，148 × 100 mm；观众领取号，工作人员在下方队列打印）</label>
          <div className="cs-actions"><button className="cs-primary" disabled={busy} onClick={() => void save()}><Save size={15} />保存</button></div>
        </div> : <div className="cs-empty"><LoaderCircle className="cs-spin" size={20} /></div>}
      </section>
      <section className="cs-card">
        <h2>现场物料</h2>
        <div className="cs-form">
          <a className="cs-primary" href="/api/creative/admin/posters.pdf" download><Download size={15} />下载展厅海报（PDF）</a>
          <p className="cs-hint">七个展厅各一张集章海报，每个已上架主题一张主题海报，每张都印有 Wi-Fi 二维码。A4 打印后张贴。</p>
          {SCREENS.map(([kind, label, use, fragment]) => <div key={kind} className="cs-field"><span>{label}<small>{use}</small></span>
            <code>{venue ? venue.base_url + '/#section=creative&' + fragment : ''}</code>
            <a className="cs-link" href={`/api/creative/admin/launcher/${kind}`} download><Download size={13} />下载{label}启动脚本</a></div>)}
          <p className="cs-hint">把启动脚本复制到屏幕电脑上双击：等平台主机开机后，用 Edge 全屏打开。第一次运行会问是否开机自动打开，选“是”后还会关闭屏幕休眠。脚本里写着当前访问地址，地址改了要重新下载。退出全屏按 Alt+F4。</p>
          <div className="cs-field"><span>集章二维码</span>
            <ul className="cs-stamp-list">{(venue?.stamps || halls.map(h => ({ ...h, url: '' }))).map(h => <li key={h.id}><b>{h.seal}</b><span>{h.name}<small>{h.chapter}</small></span>{h.url && <a href={h.url} target="_blank" rel="noreferrer">测试</a>}</li>)}</ul></div>
        </div>
      </section>
      <section className="cs-card">
        <h2><Printer size={18} />打印队列 {queued.length > 0 && <i className="cs-badge">{queued.length}</i>}</h2>
        {prints.length ? <table className="cs-table"><thead><tr><th>取件号</th><th>作品</th><th>时间</th><th>状态</th><th /></tr></thead><tbody>{prints.map(p => <tr key={p.id} className={p.status}>
          <td><strong>{p.number}</strong></td><td>{p.title}</td><td>{new Date(p.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</td>
          <td>{({ queued: '待打印', printed: '已打印', cancelled: '已取消' })[p.status]}</td>
          <td className="cs-table-actions">{p.image_url && <a href={p.image_url} target="_blank" rel="noreferrer">打开</a>}{p.status === 'queued' ? <><button onClick={() => void mark(p, 'printed')}>已打印</button><button onClick={() => void mark(p, 'cancelled')}>取消</button></> : <button onClick={() => void mark(p, 'queued')}>重新排队</button>}</td>
        </tr>)}</tbody></table> : <div className="cs-empty">{venue?.print_enabled ? '暂无打印请求' : '打印未开放'}</div>}
        <button className="cs-link" onClick={() => void loadPrints()}><RotateCw size={13} />刷新</button>
      </section>
      <section className="cs-card">
        <h2>近 30 天现场数据</h2>
        {stats ? <>
          <div className="cs-totals">{EVENTS.map(([key, label]) => <div key={key}><strong>{stats.totals[key] || 0}</strong><span>{label}</span></div>)}</div>
          <div className="cs-rank-grid">{([['views', '浏览最多的故事'], ['downloads', '保存最多'], ['works', '定制最多']] as const).map(([key, label]) => <div key={key}><h3>{label}</h3>
            {stats[key].length ? <ol>{stats[key].map(r => <li key={r.key}><span>{r.title}{r.key.includes(':') && <small>{r.key.split(':')[1]}</small>}</span><b>{r.count}</b></li>)}</ol> : <p className="cs-hint">暂无</p>}</div>)}
            <div><h3>各展厅盖章</h3><ol>{halls.map(h => <li key={h.id}><span>{h.name}</span><b>{stats.stamps[h.id] || 0}</b></li>)}</ol></div></div>
          {stats.days.length > 0 && <table className="cs-table"><thead><tr><th>日期</th>{EVENTS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead><tbody>
            {[...stats.days].reverse().slice(0, 14).map(d => <tr key={d.date}><td>{d.date.slice(5)}</td>{EVENTS.map(([key]) => <td key={key}>{d[key] || 0}</td>)}</tr>)}</tbody></table>}
        </> : <div className="cs-empty"><LoaderCircle className="cs-spin" size={20} /></div>}
      </section>
    </div>
  </div>
}
