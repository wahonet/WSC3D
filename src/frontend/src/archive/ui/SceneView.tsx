import { useEffect, useRef } from 'react';
import { locLabel, useStore } from '../store';

const CONTEXT_TITLE = '关闭时只显示武氏祠；开启后增加显示黄线范围内的周边环境和拟建传承中心。';

/** 全景模块: 共享三维画布停靠主视区 + 视角工具条 + 选中信息卡 */
export default function SceneView() {
  const { ctrl, roofOn, toggleRoof, wallsXray, toggleWallsXray, wallTransparency, setWallTransparency, walkOn, setWalk, contextOn, contextStatus, toggleContext } = useStore();
  const setStageSlot = useStore(s => s.setStageSlot);
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setStageSlot(slotRef.current);
    return () => setStageSlot(null);
  }, [setStageSlot]);

  const changeContext = () => {
    toggleContext();
    ctrl?.flyToView(contextOn ? 'pan' : 'site');
  };
  const contextLabel = !contextOn ? ''
    : contextStatus === 'ready' ? '武氏祠 · 周边环境 · 传承中心'
    : contextStatus === 'error' ? '周边模型加载失败'
    : '正在加载周边环境及传承中心…';

  return (
    <div className="scene-view">
      <div className="scene-slot" ref={slotRef} />
      <div className="scene-tools">
        <button onClick={() => ctrl?.flyToView(contextOn ? 'site' : 'pan')}>
          {contextOn ? '返回区域全景' : '返回全景'}</button>
        <span className="sep" />
        <button className={walkOn ? 'on' : ''} onClick={() => setWalk(!walkOn)}>漫游</button>
        <button className={!roofOn ? 'on' : ''} onClick={toggleRoof}>{roofOn ? '隐藏屋顶' : '显示屋顶'}</button>
        <div className="wall-xray-control">
          <button className={wallsXray ? 'on' : ''} onClick={toggleWallsXray} aria-pressed={wallsXray}
            title="调节墙体与门窗透明度，100%时完全隐藏" aria-controls={wallsXray ? 'wall-transparency' : undefined}>
            {wallsXray ? '恢复墙体' : '墙体透明'}</button>
          {wallsXray && <label className="wall-transparency" htmlFor="wall-transparency">
            <span>透明度 <output htmlFor="wall-transparency">{wallTransparency}%</output></span>
            <input id="wall-transparency" type="range" min="0" max="100" step="1"
              value={wallTransparency} aria-label="墙体透明度" aria-valuetext={`${wallTransparency}%透明`}
              onChange={e => setWallTransparency(Number(e.target.value))} />
          </label>}
        </div>
        <div className="context-control">
          <button className={'context-switch' + (contextOn ? ' on' : '')} onClick={changeContext}
            title={CONTEXT_TITLE} role="switch" aria-checked={contextOn} aria-label="周边环境及传承中心">
            <span className="switch-track" aria-hidden="true"><span /></span>周边环境及传承中心</button>
          {contextOn && contextStatus !== 'ready' && <span className="context-status" role="status">{contextLabel}</span>}
          {contextOn && contextStatus === 'error' && <button onClick={() => ctrl?.setContext(true)}>重新加载周边模型</button>}
        </div>
      </div>
      <SceneCard />
      {walkOn && (
        <div className="walk-tip">
          W A S D 移动 · 按住拖动转视角 · Shift 加速 · Esc 退出
        </div>
      )}
    </div>
  );
}

function SceneCard() {
  const { selectedId, stones, detail, select, ctrl, setModule } = useStore();
  if (!selectedId) return null;
  const brief = stones.find(s => s.id === selectedId);
  const d = detail;
  const name = d?.name || brief?.name || selectedId;
  const size = d?.size_cm || brief?.size_cm;
  const coordinates = ctrl?.getCoordinates?.(selectedId);
  return (
    <div className="sc-card">
      <div className="sc-name">
        {name}
        <button className="sc-x" aria-label="关闭文物信息卡" onClick={() => select(null)}>✕</button>
      </div>
      <div className="sc-meta">
        {brief?.catalogue_no && <>{brief.catalogue_no} · </>}
        {locLabel(d?.location || brief?.location)}
        {size && <> · {size.join('×')} cm</>}
      </div>
      <div className="sc-btns">
        <button className="pri" onClick={() => setModule('ledger')}>打开档案</button>
        <button onClick={() => ctrl?.focus(selectedId)}>定位</button>
      </div>
      {coordinates && <div className="sc-meta" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.7 }}>
        北纬 {coordinates.latitudeDeg.toFixed(7)}° · 东经 {coordinates.longitudeDeg.toFixed(7)}°
      </div>}
    </div>
  );
}
