import { useCallback, useEffect, useRef, useState } from 'react'
import { Cpu, Eraser, Play, Save, Undo2 } from 'lucide-react'
import { segLoad, segStatus, segUnload } from '../../api'
import { ENGINE_SHORT, PROMPT_PRESETS } from '../../lib/constants'
import { useApp } from '../../store/useApp'
import { toast } from '../../store/useToast'
import type { SegEngine, SegPreprocess, SegStatus, SegTiling } from '../../types'
import { Button, Chip, Kbd, Range, Switch } from '../ui'

const ENGINES: SegEngine[] = ['mobilesam', 'sam3', 'sam3.1']
const PREPROCESS: [SegPreprocess, string, string][] = [
  ['none', '原图', '不做处理'],
  ['enhance', '增强', '去光照渐变 + 局部对比增强，照片首选'],
  ['rubbing', '仿拓片', '再做自适应二值化，让照片长得像拓片'],
]
const TILING: [SegTiling, string, string][] = [
  ['none', '整图', '模型内部只用 1008 px，小人物几乎没有像素'],
  ['preview', '切块 2560', '整图 + 约 9 个 1024 切块（预览图），小目标召回明显提高'],
  ['hires', '切块 5120', '整图 + 约 35 个切块（高清工作图），最细但最慢；首次需生成工作图'],
]

export default function SegmentPanel() {
  const seg = useApp(s => s.seg)
  const setSegEngine = useApp(s => s.setSegEngine)
  const setSegPrompt = useApp(s => s.setSegPrompt)
  const setSegThreshold = useApp(s => s.setSegThreshold)
  const setSegPromptMode = useApp(s => s.setSegPromptMode)
  const setSegPreprocess = useApp(s => s.setSegPreprocess)
  const setSegInvert = useApp(s => s.setSegInvert)
  const setSegTiling = useApp(s => s.setSegTiling)
  const setViewPreprocessed = useApp(s => s.setViewPreprocessed)
  const undoSegPoint = useApp(s => s.undoSegPoint)
  const undoSegBox = useApp(s => s.undoSegBox)
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
  const boxMode = isText && seg.promptMode === 'box'
  const gpu = st?.worker.gpu ? st.worker.gpu.replace('NVIDIA GeForce ', '').replace(' Laptop GPU', '') : null
  const weightMissing = st && seg.engine in st.weights && !st.weights[seg.engine].exists
  const canRunText = !!seg.prompt.trim() || (boxMode && seg.boxes.length > 0)
  const kept = seg.dets.length - seg.excluded.length

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
          <div className="row between">
            <span className="hint"><b>提示方式</b></span>
            <span className="chips">
              <Chip size="sm" on={!boxMode} onClick={() => setSegPromptMode('text')}>文字</Chip>
              <Chip size="sm" on={boxMode} onClick={() => setSegPromptMode('box')}
                title="在图上框出一个典型目标，模型按它找同类；与文字叠加效果最好">文字 + 示例框</Chip>
            </span>
          </div>
          <div className="chips">
            {PROMPT_PRESETS.map(([zh, en]) => (
              <Chip key={en} size="sm" on={seg.prompt === en} onClick={() => setSegPrompt(en)}>{zh}</Chip>
            ))}
          </div>
          <input className="input sm" value={seg.prompt} onChange={e => setSegPrompt(e.target.value)}
            placeholder={boxMode ? '概念词（可选，建议保留，如 person）' : '概念词（英文效果好），如 person / carved figure'}
            onKeyDown={e => { if (e.key === 'Enter' && canRunText && !seg.busy) runTextSeg() }} />
          {boxMode && (
            <div className="row between">
              <span className="hint">
                在图上<b>拖拽</b>框住一个典型目标作正例，<Kbd>Alt</Kbd> 拖拽为负例。已框 <b>{seg.boxes.length}</b> 个
              </span>
              <Button size="xs" icon={<Undo2 size={11} />} onClick={undoSegBox} disabled={seg.boxes.length === 0}>撤销</Button>
            </div>
          )}

          <div className="row between">
            <span className="hint"><b>预处理</b></span>
            <span className="chips">
              {PREPROCESS.map(([k, lb, tip]) => (
                <Chip key={k} size="sm" on={seg.preprocess === k} onClick={() => setSegPreprocess(k)} title={tip}>{lb}</Chip>
              ))}
            </span>
          </div>
          {seg.preprocess !== 'none' && (
            <div className="row between">
              <Switch checked={seg.viewPreprocessed} onChange={setViewPreprocessed}>查看预处理图</Switch>
              {seg.preprocess === 'rubbing' && <Switch checked={seg.invert} onChange={setSegInvert}>反相</Switch>}
            </div>
          )}

          <div className="row between">
            <span className="hint"><b>推理范围</b></span>
            <span className="chips">
              {TILING.map(([k, lb, tip]) => (
                <Chip key={k} size="sm" on={seg.tiling === k} onClick={() => setSegTiling(k)} title={tip}
                  disabled={boxMode && seg.boxes.length > 0 && k !== 'none'}>{lb}</Chip>
              ))}
            </span>
          </div>
          {boxMode && seg.boxes.length > 0 && seg.tiling !== 'none' && (
            <div className="hint">示例框的特征来自本图，切块后其他块看不到示例——有示例框时按整图推理。</div>
          )}

          <div className="row between">
            <span className="hint">阈值 <b>{seg.threshold.toFixed(2)}</b></span>
            <span className="hint">照片建议 0.10 起；越低候选越多</span>
          </div>
          <Range min={0.05} max={0.9} step={0.05} value={seg.threshold} onChange={e => setSegThreshold(Number(e.target.value))} />
          <div className="row">
            <Button variant="primary" size="sm" icon={<Play size={13} />} onClick={runTextSeg}
              disabled={!canRunText || seg.busy}>
              {seg.busy ? (seg.tiling === 'hires' ? '推理中（切块较多）…' : '推理中…') : '识别并分割'}
            </Button>
            <Button size="sm" icon={<Eraser size={13} />} onClick={clearSeg}
              disabled={seg.dets.length === 0 && seg.boxes.length === 0} title="清除候选与示例框" />
          </div>
        </>
      )}

      {seg.dets.length > 0 && (
        <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="row between">
            <span className="hint">
              候选 <b>{seg.dets.length}</b> 个{seg.excluded.length > 0 && <>，已剔除 {seg.excluded.length}</>}
              {seg.lastInfo && <span className="muted"> · {seg.lastInfo}</span>}
            </span>
            <Button variant="primary" size="sm" icon={<Save size={13} />} onClick={saveSeg} disabled={kept === 0}>
              保存 {kept} 个为标注
            </Button>
          </div>
          {isText && <div className="hint">青色为候选（标注为分数），<b>点击候选可剔除 / 恢复</b>；剔除的不会保存。</div>}
        </div>
      )}
      <div className="hint">机器候选须人工核对；保存后进入「分割图层」，可整层显隐。</div>
    </div>
  )
}
