import { useCallback, useEffect, useRef, useState } from 'react'
import { Cpu, Eraser, Play, Save, Undo2 } from 'lucide-react'
import { segLoad, segStatus, segUnload } from '../../api'
import { ENGINE_SHORT, PROMPT_PRESETS } from '../../lib/constants'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { SegEngine, SegStatus } from '../../types'
import { Button, Chip, Kbd, Range } from '../ui'

const ENGINES: SegEngine[] = ['mobilesam', 'sam3', 'sam3.1']

export default function SegmentPanel() {
  const seg = useApp(s => s.seg)
  const setSegEngine = useApp(s => s.setSegEngine)
  const setSegPrompt = useApp(s => s.setSegPrompt)
  const setSegThreshold = useApp(s => s.setSegThreshold)
  const undoSegPoint = useApp(s => s.undoSegPoint)
  const clearSeg = useApp(s => s.clearSeg)
  const runPointSeg = useApp(s => s.runPointSeg)
  const runTextSeg = useApp(s => s.runTextSeg)
  const saveSeg = useApp(s => s.saveSeg)

  const [st, setSt] = useState<SegStatus | null>(null)
  const pollRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try { setSt(await segStatus()) } catch (e) { toast.error(e) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const loading = st && Object.values(st.engines).some(e => e.status === 'loading')
    if (loading && pollRef.current == null) pollRef.current = window.setInterval(refresh, 2500)
    if (!loading && pollRef.current != null) { window.clearInterval(pollRef.current); pollRef.current = null }
    return () => { if (pollRef.current != null) { window.clearInterval(pollRef.current); pollRef.current = null } }
  }, [st, refresh])

  const engineState = st?.engines[seg.engine]
  const status = engineState?.status ?? 'idle'
  const ready = status === 'ready'
  const isText = seg.engine !== 'mobilesam'
  const gpu = st?.worker.gpu ? st.worker.gpu.replace('NVIDIA GeForce ', '').replace(' Laptop GPU', '') : null
  const weightMissing = st && seg.engine in st.weights && !st.weights[seg.engine].exists

  const load = async () => {
    try {
      const r = await segLoad(seg.engine)
      if (!r.ok && r.error) toast.error(r.error)
      await refresh()
    } catch (e) { toast.error(e) }
  }
  const unload = async () => {
    try {
      const r = await segUnload(seg.engine)
      if (!r.ok && r.error) toast.error(r.error)
      await refresh()
      toast.ok('已卸载并释放显存')
    } catch (e) { toast.error(e) }
  }

  return (
    <div className="sub accent-seg">
      <div className="chips">
        {ENGINES.map(k => (
          <Chip key={k} on={seg.engine === k} onClick={() => setSegEngine(k)}>{ENGINE_SHORT[k]}</Chip>
        ))}
      </div>

      <div className={`seg-status ${status}`}>
        <span className="dot" />
        <Cpu size={12} className="muted" />
        <span>{gpu ? `GPU ${gpu}` : st?.worker.available ? '工作环境就绪' : '工作环境未找到'}</span>
        <span className="muted">·</span>
        <b>{status === 'idle' ? '未加载' : status === 'loading' ? '加载中' : status === 'ready' ? '就绪' : '错误'}</b>
      </div>
      {status === 'error' && <div className="note-box error">{engineState?.detail}</div>}
      {weightMissing && <div className="note-box warn">权重文件缺失：{seg.engine}（见 ml/ 目录说明）</div>}
      {status === 'loading' && engineState?.detail && <div className="hint">{engineState.detail}</div>}

      <div className="row">
        {!ready
          ? <Button variant="primary" size="sm" onClick={load} disabled={status === 'loading' || !!weightMissing}>
              {status === 'loading' ? '加载中…' : '加载引擎'}
            </Button>
          : <Button variant="danger" size="sm" onClick={unload}>卸载（释放显存）</Button>}
      </div>

      {ready && !isText && (
        <>
          <div className="hint">
            单击加<b>正点</b>，<Kbd>Alt</Kbd> + 单击加<b>负点</b>。已选 <b>{seg.points.length}</b> 点。
          </div>
          <div className="row">
            <Button variant="primary" size="sm" icon={<Play size={13} />} onClick={runPointSeg}
              disabled={seg.points.length === 0 || seg.busy}>
              {seg.busy ? '推理中…' : '生成掩膜'}
            </Button>
            <Button size="sm" icon={<Undo2 size={13} />} onClick={undoSegPoint} disabled={seg.points.length === 0} title="撤销上一点" />
            <Button size="sm" icon={<Eraser size={13} />} onClick={clearSeg}
              disabled={seg.points.length === 0 && seg.dets.length === 0} title="清除点与候选" />
          </div>
        </>
      )}

      {ready && isText && (
        <>
          <div className="chips">
            {PROMPT_PRESETS.map(([zh, en]) => (
              <Chip key={en} size="sm" on={seg.prompt === en} onClick={() => setSegPrompt(en)}>{zh}</Chip>
            ))}
          </div>
          <input className="input sm" value={seg.prompt} onChange={e => setSegPrompt(e.target.value)}
            placeholder="概念词（英文效果好），如 person / horse"
            onKeyDown={e => { if (e.key === 'Enter' && seg.prompt.trim() && !seg.busy) runTextSeg() }} />
          <div className="row between">
            <span className="hint">阈值 <b>{seg.threshold.toFixed(2)}</b></span>
            <span className="hint">越低检出越多</span>
          </div>
          <Range min={0.05} max={0.9} step={0.05} value={seg.threshold} onChange={e => setSegThreshold(Number(e.target.value))} />
          <div className="row">
            <Button variant="primary" size="sm" icon={<Play size={13} />} onClick={runTextSeg}
              disabled={!seg.prompt.trim() || seg.busy}>
              {seg.busy ? '推理中…' : '识别并分割'}
            </Button>
            <Button size="sm" icon={<Eraser size={13} />} onClick={clearSeg} disabled={seg.dets.length === 0} title="清除候选" />
          </div>
        </>
      )}

      {seg.dets.length > 0 && (
        <div className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <span className="hint">候选掩膜 <b>{seg.dets.length}</b> 个（青色虚线）</span>
          <Button variant="primary" size="sm" icon={<Save size={13} />} onClick={saveSeg}>保存为标注</Button>
        </div>
      )}
      <div className="hint">机器候选须人工核对；保存后进入「分割图层」，可整层显隐。</div>
    </div>
  )
}
