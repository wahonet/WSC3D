import { PAGES } from '../lib/constants'
import { fmtBytes } from '../lib/format'
import { useApp } from '../store/useApp'
import { Kbd } from './ui'

/** 首页中央（未打开素材时）：全库统计 + 流水线说明 */
export default function Home() {
  const stats = useApp(s => s.stats)
  const stones = useApp(s => s.stones)
  const setPage = useApp(s => s.setPage)

  return (
    <div className="home">
      <div className="home-inner">
        <div>
          <h1>Stone<em>Lab</em> · 汉画像石研究平台</h1>
          <p>
            面向武氏祠画像石的本地研究平台。工作按流水线推进：<b>对齐</b>把各图接入统一坐标系，
            <b>分割</b>把画面切成实体，<b>标注</b>给每个实体定层级、概念与图像志描述，<b>文献</b>把释文与文献段落关联到节点；
            首页集中展示成果。先在左侧列表打开一件素材。
          </p>
        </div>

        {stats && (
          <div className="stat-grid">
            <div className="stat"><div className="v">{stats.stones}</div><div className="k">画像石</div></div>
            <div className="stat"><div className="v">{stats.assets_2d} <span className="muted" style={{ fontSize: 13 }}>+ {stats.assets_3d} 三维</span></div><div className="k">照片 / 局部 / 拓片</div></div>
            <div className="stat"><div className="v">{stats.annotations}</div><div className="k">节点（{stats.linked_annotations} 条已关联释文）</div></div>
            <div className="stat"><div className="v">{stats.previews_cached}</div><div className="k">预览缓存 · {fmtBytes(stats.preview_cache_bytes)}</div></div>
          </div>
        )}

        <div className="step-grid four">
          {PAGES.filter(p => p.step).map(p => (
            <button key={p.id} className="step" onClick={() => setPage(p.id)}>
              <div className="n">{p.step}</div>
              <div>
                <div className="t">{p.label}</div>
                <div className="d">{p.desc}</div>
              </div>
            </button>
          ))}
        </div>

        <div className="keys">
          <span><Kbd>V</Kbd>选中</span>
          <span><Kbd>M</Kbd>测量（首页）</span>
          <span><Kbd>A</Kbd>绘制 <Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd><Kbd>4</Kbd>矩形 / 圆形 / 多边形 / 点（分割）</span>
          <span><Kbd>S</Kbd>SAM 分割</span>
          <span><Kbd>F</Kbd>适应窗口</span>
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd>结构树上下 <Kbd>Enter</Kbd>定位 <Kbd>R</Kbd>候选转正 <Kbd>Ctrl+S</Kbd>保存表单</span>
          <span><Kbd>Esc</Kbd>取消绘制 / 取消选中</span>
          <span><Kbd>Del</Kbd>删除选中</span>
          {stones.length === 0 && <span className="muted">暂无石头：把素材放入 assets/stones/ 后点右上角「重新扫描」</span>}
        </div>
      </div>
    </div>
  )
}
