# 首页改版交接文档

> 写给下一个对话：本次任务是把平台首页改成「学术检索 + 博物馆首页」风格。
> 代码已经全部写好并通过构建，平台已在 http://127.0.0.1:8030/ 运行新首页。
> 剩下的工作是：复核浅色主题和手机端显示、按用户反馈微调、以及清理 `homepage-mockups/` 文件夹。

## 一、用户的需求（原话要点）

- 在「学术检索」方案（homepage-mockups/05-scholar.html）的基础上，结合博物馆首页的结构和视觉层级做改动。
- 标题直接写实物名，例如「嘉祥武氏墓群石刻」「荆轲刺秦王」「管仲射小白」。
- **禁止**文艺口号：不要「循石迹」「见汉风」「掌一盏灯，细读汉代石头」这类话。
- 用平台真实数据（数量、引文、图片），不要编造。
- 保留原有导航和全部功能入口。

## 二、最终设计（已实现）

从上到下：

1. **Masthead 首屏**：后展厅三维渲染图做底（左深右浅渐变压暗），左侧依次是
   「嘉祥武氏墓群石刻」衬线大标题 → 副标「东汉 · 山东省济宁市嘉祥县 · 第一批全国重点文物保护单位」
   → 白底大检索框（输入直接跳 SearchPage）→「常用：」六个示例词 → 一行实时统计
   （文物档案 150 件 / 三维模型 88 件 / 核心文献 10 部 / 扩展书目 283 条，全部来自 `/api/archive/stats`）。
   右下角小字标注「后展厅 · 三维场景」。
2. **栏目条**（首屏下沿、横跨整宽）：7 个入口按钮 = 文物档案/院落全景/画像形象库/故事形象库/知识图谱/传承中心/电子文创。
3. **主栏 · 故事场景与出处**：4 条故事（荆轲刺秦王、管仲射小白、二桃杀三士、周公辅成王），
   每条 = 左图（按标注框裁切的原石画面）+ 故事名 + 原石编号与位置 + 「N 条文献与插图」+
   原文引文 + 可点击的引文出处（作者《书名》，年，第 N 页 → 打开文献对应页）。
4. **主栏 · 精品十六幅**：拓片缩略图 4 列网格，点击进入该石档案。
5. **侧栏**：院落导览（西长廊渲染图 + 五区域件数表 + 进入按钮）、核心文献（DOC-001~010，
   点击打开文档预览）、「引用与下载」说明卡。
6. **页脚**：一行灰色小字。

### URL 状态机制（上一轮设计的深链方案，必须保持）

- 新首页线上地址：`http://127.0.0.1:8030/#section=overview`
- 用户实际看到的地址形如：
  `http://127.0.0.1:8030/#section=overview&scope=core&a=15&stone=武011`
- 这套 hash 参数是**全平台共享的深链状态**（上一轮设计），不是首页私有参数：

| 参数 | 含义 | 读写位置 |
|---|---|---|
| `section` | 当前主区域（overview/archive/scene/research/library/search/graph/motifs/stories/center/creative） | `goToSection()` 统一设置 |
| `stone` | 档案/研究当前选中的原石，如 `武011` | `App.tsx` 启动时读（约 95 行）并回写（约 129 行）；hashchange 时 `useStore.select()`（约 144 行） |
| `a` | 当前选中的 asset id | `store/useApp.ts` 约 161 行 |
| `scope` | 文献库 core / extension | `App.tsx` 约 60、130、145 行 |
| `story` / `story_stone` / `motif` | 故事库、形象库深链 | `goToSection('stories', {story, story_stone})` 等 |
| `doc` / `pg` / `seg` / `fig` / `lib` / `q` | 文献中心定位参数 | `openDocument()` |

- **关键行为**：`goToSection()`（`lib/navigation.ts` 13–21 行）只覆盖 `section` 和显式传入的参数，
  **其余参数原样保留**。所以从档案页（选中武011、asset 15、scope=core）点回总览，URL 就变成上面那样；
  再从首页点「文物档案」，档案页会恢复到武011/asset 15 的上下文——这是特性，不是 bug。
- 首页自身不读 `stone`/`a`/`scope`，但必须保证首页里所有跳转都走 `goToSection` /
  `onStone` / `onSearch` / `previewDocument`，不要直接改 `location.hash` 覆盖全部参数，
  否则会打断「回到刚才浏览位置」的机制。当前实现已满足。

## 三、改动的文件

| 文件 | 改动 |
|---|---|
| `src/frontend/src/pages/OverviewPage.tsx` | **整体重写**（约 200 行）。删除了旧 hero 文案与四宫格卡片。 |
| `src/frontend/src/pages/overview.css` | **整体重写**。新 class 前缀 `.ov-*`；文件尾部保留了壳层共用规则（`.unified-brand-logo`、`.unified-brand-home`、`.unified-search` 等）和响应式/减动效媒体查询，勿删。 |
| `src/frontend/src/theme.css` | 删除了约 30 行已失效的 `.museum-*` 覆盖块（新代码不再使用这些 class）。 |
| `src/frontend/src/App.tsx` | 两处小改：给 `<OverviewPage>` 传 `onSearch`（设 query/submitted 并 `navigate('search')`）；`liftSelector` 里 `.museum-intro` → `.ov-masthead-copy`。 |
| `src/frontend/src/api.ts` | 新增一行 `getAnnotation(id)`（GET `/api/annotations/{id}`）。 |
| `src/frontend/src/archive/types.ts` | `Stats` 增加可选字段 `core_books?: number`。 |
| `src/backend/app/routers/annotations.py` | 单条 annotation 读取现在带 `references`（首页引文依赖它）。 |

新增图片资源（已在 `src/frontend/public/brand/`，构建后复制到 `build/web/brand/`）：
`hall-rear.jpg`（首屏底图）、`hall-west.jpg`（侧栏导览图）。均由项目自带 4K 渲染图缩放而来。
`museum-gate.webp` 目前未被引用，可留可删。

## 四、关键实现细节

- **故事数据**：`FEATURED_STORY_IDS = [98, 97, 261, 228]`（荆轲刺秦王、管仲射小白、二桃杀三士、
  周公辅成王）。通过新的 `GET /api/annotations/{id}` 拿整条记录，引文取 `references` 里
  `kind === 'segment'` 且有 `text` 的第一条。标注框裁切用 `bounds(geometry)` + `cropStyle()`
  计算 CSS 偏移，图片走 `previewUrl(asset.id)`。
- **核心文献**：`listDocuments('core')` 按 `code` 排序展示；点击调 `previewDocument({collection:'core', documentId, pageNo})`。
  引文出处点击也走 `previewDocument`（core 找不到的 document_id 回退到 extension collection）。
- **统计**：`useStore(s => s.stats)`（archive store 的 `getStats()`）。`core_books` 后端字段若不存在则回退 `documents.length`。
- **首屏大图在浅色主题下也是深色图**，是有意为之（博物馆海报式），masthead 文字固定浅色。
- 缓存：`plateCache`/`storyCache`/`coreDocuments` 都是模块级，避免重复请求。

## 五、验证状态

- `tools/bootstrap.ps1 -Mode build`（tsc + vite）**通过**，产物在 `build/web`。
- 平台经 `启动平台.bat`（计划任务方式）启动，`/api/health` 与 `GET /api/annotations/98` 均 200。
- **深色主题 1440px 截图已人工复核**：布局、引文、图片、统计全部正常
  （截图在 `C:\Users\wahonet\AppData\Local\Temp\wsc_audit\shots\home-dark.png`，可能被清理）。
- **带遗留参数的深链 URL 已实测**：`#section=overview&scope=core&a=15&stone=武011` 正常渲染新首页，
  参数被忽略但保留（用于回到档案页的上下文），符合设计预期。
- ⚠️ **浅色主题截图未完成**（headless Edge 第二次启动挂起，重试中）。配色理论上走
  `--bg-*/--text-*/--accent` 变量会自动适配，但需要人工看一眼确认。
- ⚠️ **未做**：手机窄屏实机检查、检索跳转的实际点击测试、引文链接跳转测试。

## 六、待办（下一个对话接着做）

1. 复核浅色主题与窄屏（≤700px 有断点：栏目 2 列、故事单列、精品 2 列）。
2. 在浏览器里实测：检索框回车 → 搜索页；故事标题 → 故事库对应条目；引文 → 文献对应页；
   精品图 → 档案页；栏目条七个入口。
3. 按用户反馈微调文案/图片/栏目顺序。
4. 用户确认后删除 `homepage-mockups/` 整个文件夹（8 个 HTML + assets，约 24 MB）。
   其中 `homepage-mockups/assets/` 里的图若日后要复用，源图都在 `resources/` 里，可再生成。
5. 可选：`README.md` 约 563 行的首页描述仍写旧版，需要更新；`museum-gate.webp` 未使用。
6. 可选：Noto Serif SC 目前依赖系统字体回退（宋体），若要在无网环境保证衬线效果需打包字体文件。

## 七、环境备忘

- 项目 `F:\wsc-unified`，Windows。平台端口 8030，入口 `启动平台.bat`。
- 构建：`powershell -File tools\bootstrap.ps1 -Mode build`；停止：`-Mode stop`。
- 测试按文件单独跑（`tools/run.ps1 <file>` 或逐文件 python），不要整目录 pytest。
- headless 截图：`msedge --headless=new --screenshot=... --window-size=1440,2400 --virtual-time-budget=15000 <url>`；
  浅色主题需先写 localStorage `stonelab.theme=light`（可用一个临时 html 跳转页实现）。
- 仓库有大量本任务之外的未提交改动（存储清理、annotations 测试等），不要 `git checkout` 或 reset。
