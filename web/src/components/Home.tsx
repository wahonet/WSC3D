import { fmtBytes } from '../lib/format'
import { useApp } from '../store/useApp'
import { Kbd } from './ui'

export default function Home() {
  const stats = useApp(s => s.stats)
  const stones = useApp(s => s.stones)

  return (
    <div className="home">
      <div className="home-inner">
        <div>
          <h1>Stone<em>Lab</em> · 汉画像石研究平台</h1>
          <p>
            面向武氏祠画像石的本地研究工作台：高清照片、拓片与三维低模的浏览、标注、测量、
            SAM 分割，基于主图的统一坐标系对齐与跨图标注投影，以及图文关联研究。
            从左侧列表打开一件素材开始。
          </p>
        </div>

        {stats && (
          <div className="stat-grid">
            <div className="stat"><div className="v">{stats.stones}</div><div className="k">画像石</div></div>
            <div className="stat"><div className="v">{stats.assets_2d} <span className="muted" style={{ fontSize: 13 }}>+ {stats.assets_3d} 三维</span></div><div className="k">照片 / 局部 / 拓片</div></div>
            <div className="stat"><div className="v">{stats.annotations}</div><div className="k">标注（{stats.linked_annotations} 条已图文关联）</div></div>
            <div className="stat"><div className="v">{stats.previews_cached}</div><div className="k">预览缓存 · {fmtBytes(stats.preview_cache_bytes)}</div></div>
          </div>
        )}

        <div className="step-grid">
          <div className="step">
            <div className="n">1</div>
            <div>
              <div className="t">浏览与标注</div>
              <div className="d">左侧选择照片或拓片；用 标注 / 测量 / 分割 工具在图上工作，右侧查看简介与标注列表。</div>
            </div>
          </div>
          <div className="step">
            <div className="n">2</div>
            <div>
              <div className="t">对齐入链</div>
              <div className="d">用 对齐 工具把各图与主图配准（至少 4 对同名点），接入统一坐标系后即可跨图投影标注。</div>
            </div>
          </div>
          <div className="step">
            <div className="n">3</div>
            <div>
              <div className="t">图文关联研究</div>
              <div className="d">顶部切换到「研究」模块，编辑元数据与释文，将标注与权威文字双向绑定并锁定保护。</div>
            </div>
          </div>
        </div>

        <div className="keys">
          <span><Kbd>V</Kbd>选中</span>
          <span><Kbd>A</Kbd>标注</span>
          <span><Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd>矩形 / 多边形 / 点</span>
          <span><Kbd>M</Kbd>测量</span>
          <span><Kbd>S</Kbd>分割</span>
          <span><Kbd>L</Kbd>对齐</span>
          <span><Kbd>F</Kbd>适应窗口</span>
          <span><Kbd>Esc</Kbd>取消绘制 / 回到选中</span>
          <span><Kbd>Del</Kbd>删除选中标注</span>
          {stones.length === 0 && <span className="muted">暂无石头：把素材放入 assets/stones/ 后点右上角「重新扫描」</span>}
        </div>
      </div>
    </div>
  )
}
