import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { reconstructionFile, type ReconstructionCase, type ReconstructionDimension } from '../../lib/reconstruction'

export const dimensionList = (v?: (number | null)[]) => v?.map(x => x === null ? '另见原页' : Number(x.toFixed(3))).join(' × ') || '未提供'

export default function ReconstructionDimensions({ data }: { data: ReconstructionCase }) {
  const [rows, setRows] = useState<ReconstructionDimension[]>([]), [error, setError] = useState(''), [query, setQuery] = useState('')
  useEffect(() => {
    if (!data.dimensionFile) return
    const abort = new AbortController()
    void fetch(reconstructionFile(data.id, data.dimensionFile), { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error(r.status === 401 ? '请重新登录工作台' : '尺寸表读取失败')
      setRows(await r.json())
    }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [data.id, data.dimensionFile])
  if (!data.dimensionFile) return <p>本版本的等比尺寸来自登记值，尚未进行可信标尺校准。请切换到 R02 的尺寸核查表。</p>
  return <>
    <div className="rc-panel-heading"><b>尺寸核查 · 含 R01 五石</b><span>{rows.length} 件记录</span></div>
    <p>目前没有可认定为准确厘米尺寸的结果。下列跨度可由原网格重复计算，但单位尚未核定；文献值仍是历史著录。</p>
    <div className="rc-dimension-links">{data.dimensionCsv && <a href={reconstructionFile(data.id, data.dimensionCsv, true)}>尺寸表 CSV<Download size={13} /></a>}{data.calibrationFile && <a href={reconstructionFile(data.id, data.calibrationFile, true)}>标尺采集表 JSON<Download size={13} /></a>}</div>
    <label className="rc-search">查找石件<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="石号、名称，如 009" /></label>
    {error && <p role="alert">{error}</p>}{!rows.length && !error && <p role="status">读取尺寸表…</p>}
    {rows.filter(r => `${r.id} ${r.name} ${r.historicalName}`.includes(query.trim())).map(r => <article className="rc-dimension" key={r.id}>
      <h2>{r.id} · {r.name}</h2><span className="rc-small-status">{r.rawExtents ? '未标定' : '缺模型'}</span>
      <dl><dt>原模型 X / Y / Z 跨度 · 单位未核</dt><dd>{dimensionList(r.rawExtents)}</dd><dt>同件比例 Y/X · Z/X</dt><dd>{r.heightToWidth?.toFixed(4) ?? '—'} · {r.thicknessToWidth?.toFixed(4) ?? '—'}</dd><dt>可靠厘米尺寸</dt><dd>尚不能确定</dd><dt>原书宽 / 高 / 厚 · 厘米（非实测）</dt><dd>{dimensionList(r.publishedSizeCm)}</dd></dl><p className="rc-muted">{r.publishedNote}</p>
    </article>)}
  </>
}
