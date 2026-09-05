# StoneLab · 汉画像石研究平台

面向武氏祠（及后续 40+ 块画像石）的本地研究平台。工作按**流水线**推进，首页集中展示成果：

```text
首页（展示 / 测量 / 图层）  ←  1 对齐  →  2 分割  →  3 标注  →  4 文献
```

- **对齐**：各图（照片 / 局部 / 拓片）与主图取同名点配准，接入"主图统一坐标系"，标注可跨图投影；
- **分割**：用 SAM（点选 / 文字 / 示例框）和矩形 / 圆形 / 多边形 / 点，把画面切成一个个**实体**；
- **标注**：每个实体是结构树的一个节点（整石 → 花纹带 / 层 → 场景 → 人物·物象 → 部件；榜题、残损为旁支），
  填写状态、父级、类别、概念、三层图像志文本与榜题录文；可由释文一键生成骨架；
- **文献**：释文与已标注节点关联，文字按节点颜色高亮并锁定；书库支持 PDF 入库、批量 OCR、逐页校勘与全库检索。

路线：先把武梁祠西壁这一块做"完整"（底本、结构、文献、综合四层），再导入其他石头。
文献库已可使用；后续补充节点与原书文段 / 插图之间的证据关联。

技术栈：FastAPI + SQLAlchemy + SQLite（后端），React 19 + TypeScript + Vite（前端），
OpenSeadragon（深度缩放）、three.js（三维）、zustand（状态）、react-resizable-panels（可拖拽布局）。

> 本仓库只包含**程序**。照片 / 拓片 / 三维、文献 PDF、石头简介与释文（`meta.json`）、标注数据库均不入库，见第十一节。

## 一、目录结构

```text
stonelab/
├─ assets/                     素材区（不入库；导入新石头只动这里）
│  └─ stones/
│     └─ WS-003_武梁祠西壁/
│        ├─ meta.json          石头信息（era/material/carving/dims_text/location/description/layers），不入库
│        ├─ photos/            全幅高清照片
│        │  └─ 历代帝王（加强版）/   photos 下任意子文件夹 = "局部"分组
│        ├─ rubbings/          拓片
│        └─ models/high|mid|low/   各一套 obj + mtl + 贴图（界面只展示低模）
├─ assets/library/             文献 PDF（不入库；DOC-001_书名.pdf）
├─ ml/                         模型权重与 OCR 环境（不入库）
│  ├─ mobilesam/mobile_sam.pt            40 MB   点选分割（CPU）
│  ├─ sam3/sam3.pt                       3.45 GB facebook/sam3 文本分割（GPU）
│  ├─ sam3.1/**/sam3.1_multiplex_fp16.safetensors  1.75 GB SAM3.1 文本分割（GPU）
│  └─ ocr/                     mineru-venv/（MinerU + CUDA torch）· ndl-venv/ · ndlkotenocr-lite/src（引擎 + 80 MB ONNX 模型）
├─ server/                     后端
│  ├─ app/
│  │  ├─ main.py               应用入口：生命周期（建表/迁移/播种概念/启动扫描）、CORS、异常处理、托管 web/dist
│  │  ├─ config.py             全部路径与参数（环境变量可覆盖）
│  │  ├─ db.py · models.py · migrations.py · schemas.py
│  │  ├─ constants.py          资产分组 + 结构枚举（层级 / SOP 类别 / 审核状态 / 质量 / 几何语义）
│  │  ├─ knowledge.py          概念分类骨架（11 大类 × 小类）与种子概念（SOP 母题 + 汉画常见人物物象）
│  │  ├─ routers/              system / stones（含 structure 骨架与归类）/ assets / annotations / concepts / library / segment / alignment
│  │  ├─ services/             scanner / previews / alignment / transforms / textlinks / structure / seeds / library / segment / serialize
│  │  ├─ sam_worker.py         SAM 推理子进程（独立 Python 环境中运行）
│  │  ├─ ocr_worker.py         OCR 子进程（--engine mineru|ndl，各在自己的环境中运行）
│  │  └─ ocr_normalize.py      MinerU 原始版面按物理页归一化，保留跨页续文的位置
│  ├─ data/                    stonelab.db · previews/ · thumbs/ · library/（页图、插图裁片、OCR 原始输出）· *.log（不入库）
│  └─ requirements.txt
├─ web/                        前端
│  ├─ src/
│  │  ├─ App.tsx（按 page 路由五个页面） · api.ts · types.ts · styles.css（设计系统）
│  │  ├─ pages/                HomePage / AlignPage / SegmentPage / AnnotatePage / LibraryPage
│  │  ├─ store/                useApp（应用状态与动作） · useToast
│  │  ├─ components/           TopBar（流水线导航）/ CenterView（查看器区）/ Home（仪表）/ StoneTree / LayerPanel /
│  │  │  │                     MeasureTools / ShapeList / AlignSidebar / AlignView / InfoPanel（元数据 + 释文关联）/
│  │  │  │                     ErrorBoundary / Toaster / ui
│  │  │  ├─ structure/         StructurePanel（结构树）/ NodeDetail（标注表单）/ ConceptPicker / SkeletonDialog
│  │  │  ├─ viewer/            Viewer2D / Viewer3D / ViewerBar（含切图）/ AnnotationShapes / NodeInfoCard / useOsd
│  │  │  ├─ tools/             ShapeTools / SegmentPanel
│  │  │  └─ library/           TextArticle（释文全文）/ BookShelf / BookPicker / LibrarySearch / 逐页校勘组件
│  │  ├─ hooks/useShortcuts.ts
│  │  └─ lib/                  constants / format / geometry（Umeyama、坐标链叠加、外接矩形）/ tree（建树、展开、进度）
│  └─ dist/                    npm run build 产物（后端可直接托管，不入库）
├─ scripts/                    校验与运维脚本（见第八节）
├─ .gitignore · .gitattributes · .editorconfig · .vscode/settings.json   仓库与编辑器约定（UTF-8、LF）
├─ 启动平台.ps1
└─ README.md
```

## 二、启动

```powershell
.\启动平台.ps1          # 开发模式：后端 8020 + Vite 前端 5173（热更新），自动打开浏览器
.\启动平台.ps1 -Prod    # 生产模式：构建前端后由后端单进程托管，访问 http://127.0.0.1:8020/
```

或手动：

```powershell
cd server ; pip install -r requirements.txt
cd server ; python -m uvicorn app.main:app --host 127.0.0.1 --port 8020    # 后端（接口文档 /docs）
cd web    ; npm install ; npm run dev                                       # 前端 → http://127.0.0.1:5173
cd web    ; npm run build                                                   # 构建后后端自动托管 web/dist
```

全部服务只绑定 127.0.0.1。数据（标注、对齐、主图、编辑内容）都在
`server/data/stonelab.db`，重启不丢；整个 stonelab 文件夹拷走即完成备份。
后端**启动时自动扫描**素材目录并在后台预热预览缓存，同时播种概念词表；顶栏「重新扫描」可随时手动触发。

### 配置（环境变量，均可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `STONELAB_HOST` / `STONELAB_PORT` | 127.0.0.1 / 8020 | 监听地址 |
| `STONELAB_ASSETS` | `<项目>/assets/stones` | 素材根目录 |
| `STONELAB_DATA` | `<项目>/server/data` | 数据库与缓存目录 |
| `STONELAB_CORS` | 5173 两个来源 | 允许的前端来源，逗号分隔 |
| `STONELAB_PREVIEW_EDGE` / `STONELAB_THUMB_EDGE` | 2560 / 320 | 预览与缩略图长边像素 |
| `STONELAB_WORK_EDGE` | 5120 | 切块推理用高清工作图长边 |
| `STONELAB_SCAN_ON_STARTUP` / `STONELAB_WARM_PREVIEWS` | 1 / 1 | 启动扫描、后台预热 |
| `STONELAB_SAM_PYTHON` | WSC3D venv | 分割工作进程的 Python 解释器 |
| `STONELAB_LIBRARY` | `<项目>/assets/library` | 文献 PDF 目录 |
| `STONELAB_OCR_PYTHON` / `STONELAB_NDL_PYTHON` | `ml/ocr/mineru-venv`、`ml/ocr/ndl-venv` | 两个 OCR 工作进程的 Python |
| `STONELAB_NDL_ROOT` / `STONELAB_OCR_DPI` | `ml/ocr/ndlkotenocr-lite` / 300 | 古籍引擎目录、OCR 页图 DPI |

## 三、界面与流水线

顶栏：品牌 · **首页 | 1 对齐 › 2 分割 › 3 标注 › 4 文献** · 面包屑（当前石头 / 图）· 重新扫描 / 接口文档 / 主题。
所有页面共用同一份状态：在任一页选的石头、图、选中节点，切到别的页都还在；查看器顶栏的下拉可随时切换同一块石头的其他图
（首页可切三维，其余模块只处理 2D）。地址栏 `#a=<资产id>&p=<页面>` 记录位置，刷新后恢复。
各栏宽度可拖拽，布局自动记住。

### 首页 · 展示

- 左上 **画像石**：石头 → 三维 / 高清照片 / 局部 / 拓片 分组树，带缩略图与主图 / 链徽标，可搜索；
- 左下 **测量与图层**：选中 / 测量两个工具（`V` / `M`，测量结果为原图像素或模型单位，未标定）与测量记录；
  图层开关——结构节点（可按层级逐个显隐）、机器候选（虚线）、节点名称、跨图投影（点划线）、
  **图像叠加**（把同石另一张已入链的图按坐标链叠到当前图上，拖透明度做拓片 / 照片比对）；
- 右侧 **预览**：照片 / 拓片走 OpenSeadragon，三维低模走 three.js；未打开素材时显示全库统计与流水线入口。
  点选图上节点弹出只读**信息卡**：名称、路径、状态、类别、概念、图像志描述、录文、关联释文。

### 模块一 · 对齐

- 左上选一张图作**左图**；左下显示坐标系状态：主图（可把当前图设为主图；已有坐标链时自动重定基，
  新主图未对齐时拒绝切换）、每张 2D 图的入链状态与 RMSE、对齐记录（可重新叠加 / 删除）；
- 中央左右分屏：右侧下拉选比对图（建议主图或任一已入链的图），左键取点（左红右蓝交替编号）、右键拖图、
  滚轮缩放；配对列表逐对删除、悬停黄圈联动；最少 4 对、至多 20 对，实时 RMSE（绿 / 黄 / 红）；
  「确定对齐」求解相似变换（Umeyama 最小二乘）并保存，配对双方任一已连主图则另一方自动接入坐标链。
- 跨图投影：同石其他已入链图上的节点以点划线投影到当前图（沿用各节点颜色），在主图上做的节点会出现在
  所有已对齐的照片 / 拓片上。相似变换只有旋转 + 缩放 + 平移，拓纸伸缩、镜头畸变带来的像素级偏差属对齐精度范围。

### 模块二 · 分割

- 左下 **分割工具**：矩形 `1` / 圆形 `2` / 多边形 `3` / 点 `4`（`A` 进入绘制；多边形连点、双击闭合、`Esc` 取消；
  圆形为内切于拖拽框的圆 / 椭圆），以及 **SAM 分割**（`S`）；
- SAM 三个引擎——点选（MobileSAM，CPU）、SAM3 / SAM3.1（文字与示例框概念分割，GPU）；模型按需加载 / 卸载，
  推理运行在独立 Python 环境的 sidecar 进程中（含 CUDA torch 与 sam3 / mobile_sam 包，路径不存在时设 `STONELAB_SAM_PYTHON`）：
  - 点选：单击加正点、`Alt` + 单击加负点，可撤销；
  - SAM3 / SAM3.1：**提示方式**（文字 / 文字 + 示例框：在图上框住一个典型目标作正例，`Alt` 拖拽为负例）、
    **预处理**（原图 / 增强 / 仿拓片 + 反相，可查看模型实际看到的图）、**推理范围**（整图 / 切块 2560 / 切块 5120，
    切块显著提高全幅照片里小人物的召回）、**阈值**（默认 0.10，照片建议 0.05–0.2 起试）；
  - 候选掩膜青色虚线并标分数，点击剔除 / 恢复；保存的候选入库为**机器候选**（`review_status=candidate`，虚线），
    并按几何包含自动归入所在层 / 场景，`note` 记录引擎、分数与参数；
- 手绘的形状直接入库为已确认的实体（`reviewed`），同样自动归类；选中**无框**骨架节点时绘制即挂接到它；
- 右侧 **本图实体**：当前图上切出的实体，按新旧排列，可筛选候选 / 已确认，逐条定位、确认（`R`）、删除或一键清空候选；
  底部「去标注」跳到模块三。

### 模块三 · 标注

- 左侧 **结构树**：一块石头的全部实体，跨图共享（别的图上的节点以「投影」显示，未入链的图上的以灰眼标记，双击切过去）。
  搜索、筛选（候选 / 无框 / 未归类 / 未关联释文）、按层级折叠、拖拽换父级（拖到顶部虚线区 = 移到顶层）、
  `Ctrl+点击` 多选后批量设层级 / 转正 / 归类 / 删除；「骨架」从释文生成节点，「归类」按几何包含归入层 / 场景，
  「节点」新建无框子节点；顶部进度：整石 / 层 / 场景 / 人物 / 榜题 数与已关联释文、已挂概念数；
- 中央图像：点选节点；选中无框节点时按 `A` 绘制即挂接；
- 右侧 **标注表单**：名称、层级、次序、状态（候选 / 已审 / 已核定 / 已否决，候选有「转正并保存」）、父级
  （下拉手选，或采纳按几何包含给出的建议）、SOP 类别、概念（搜索 / 现场新增）、释文关联（只读，去文献模块操作）、
  图像志三层文本（前图像志 / 图像志 / 图像学）、榜题录文 / 今译 / 释读注、几何（定位 / 重画）、颜色、备注、
  高级（标注质量 / 几何语义）。**修改后点「保存」**（`Ctrl+S`）；切换到别的节点时未保存的修改会自动保存。

### 模块四 · 文献

- 左侧同一棵结构树（标题显示已关联释文的节点数）；中央图像；
- 右侧 **文献与释文**：顶部是**固定不随滚动的操作栏**——显示当前选中节点，拖选文字后出现「关联到本节点」；
  正文是一篇连贯的文章：总述 + 各层释文，层名为行内小标题（上方可折叠的「石头信息」块编辑尺寸 / 年代 / 材质 / 刻法 / 收藏）。
  「编辑全文」把整篇放进一个文本框，层与层之间以 `## 第N层 · 层名` 一行分隔（可改层名，不能增减层），保存时按层拆回；
- 选中节点后**拖选一段文字 → 「关联到本节点」**，文字以节点颜色高亮并**锁定**：编辑时删改已关联文字会被拒绝（409），
  其他改动正常保存且全部关联区间自动重定位；一次只能关联同一段落（总述或某一层）内的文字，区间不能重叠；点高亮文字可反选节点。
- 「关联释文」页签的文字由著录原书人工录入 `meta.json`（重新扫描只在字段为空时填入，不覆盖人工编辑）；
  「书库」页签用于 PDF、OCR 与逐页校勘，详见第四之二节。

### 快捷键

| 键 | 作用 | 生效模块 |
|---|---|---|
| `V` / `Esc` | 选中工具；`Esc` 在选中工具下取消选中、绘制中取消 | 全部 |
| `M` | 测量 | 首页 |
| `A` · `1`/`2`/`3`/`4` | 绘制 · 矩形 / 圆形 / 多边形 / 点 | 分割（标注模块 `A` 用于给无框节点挂接） |
| `S` | SAM 分割 | 分割 |
| `F` | 适应窗口 | 全部 |
| `↑` / `↓` · `Enter` | 结构树上下移动 · 定位到选中节点 | 标注、文献 |
| `R` | 把选中的机器候选转正 | 分割、标注 |
| `Ctrl+S` | 保存标注表单 | 标注 |
| `Del` 两次 | 删除选中（多选时删全部所选；子节点上挂一级）；首页只删测量记录 | 首页、对齐、分割、标注 |

**颜色**：新建实体自动从 18 色调色板中分配当前图上用得最少的颜色；正红保留给选中态。图形描边按层级区分：
整石与层为粗线无填充，场景中等，人物细线淡填充，榜题点线；机器候选虚线；名称标签在图形屏幕宽度不足 34 px 时自动隐藏。

## 四、结构化标注（数据模型）

标注不是一张图上的平铺列表，而是**一块石头**的一棵树，跨图共享（各图经统一坐标系投影）。
规范沿用旧系统 WSC3D 的《汉画像石标注 SOP v0.3》。

| 字段（`annotations` 表） | 取值 | 说明 |
|---|---|---|
| `level` 结构层级 | whole 整石 / band 花纹带 / layer 层 / scene 场景 / figure 人物·物象 / component 部件 / inscription 榜题 / trace 刻线 / damage 残损 | 树中以单字徽标显示；层节点的 `seq` = 释文层号 |
| `parent_id` / `seq` | 父节点 / 同级次序 | 只校验同石、不成环；层级嵌套只作建议与默认值 |
| `category` 一层类别 | SOP 14 类 + unknown（创世主神、仙人异士、神话帝王、忠臣刺客、孝子、烈女、乐舞、车马、神兽、天象、生活场景、建筑、题刻、纹饰） | 跨石头互斥大类，未来做检测模型的训练池 |
| 概念 `annotation_concepts` | 多对多，挂 `concepts` 表 | 概念挂在 11 大类 × 小类的分类骨架下（人 / 天然 / 人造 / 想象 / 纹样 / 故事典故 / 题刻 / 形态 / 行为 / 关系 / 复合），启动时播种 269 条（SOP 母题 + 汉画常见人物物象），界面可现场新增 |
| `semantics` 图像志三层 | pre_iconographic 直观描述 / iconographic 主题识别 / iconological 文化阐释 + inscription{transcription 录文, translation, notes} | 榜题节点显示录文子面板 |
| `review_status` | candidate 候选 / reviewed 已审 / approved 已核定 / rejected 已否决 | SAM 产物默认 candidate（虚线）；转正 = reviewed |
| `quality` / `geometry_intent` | weak/silver/gold；visible_trace/semantic_extent/reconstructed_extent | 「高级」折叠区 |
| 几何 | `atype` rect / ellipse / polygon / point；`none` + `geometry={}` 为**无框骨架节点** | 圆形投影与包含判断按 32 边多边形处理 |
| `desc_source/desc_start/desc_end/desc_text` | 释文关联 | 文本源为 `description`（总述）或 `layer:N` |

**从释文生成骨架**（标注模块「骨架」）：后端解析总述与各层释文——"一则 / 二则"为场景、"首刻 / 次一人"为人物、
"数词 + 名词"枚举为物象、引号内为榜题录文、"第 N、M 层间饰…花纹带"为花纹带——预览勾选（可改名）后创建；
场景与人物节点自动关联到对应释文区段，名称能匹配的自动挂概念，已有同名节点默认不再创建。节点先无框，
之后在分割 / 标注模块绘制挂接，或把 SAM 候选拖到节点上「并入几何」（几何、子节点、概念、释文关联一并转移）。
解析针对蒋英炬、吴文祺释文的行文习惯，其他体例的释文需要人工多改名。

**验收**：结构树筛选芯片 候选 / 无框 / 未归类 / 未关联释文 清零，即该石"结构完整"。

## 四之二、文献库与 OCR

文献来自书。PDF 放进 `assets/library/`（不入库），启动或 `POST /api/library/scan` 自动登记为 `documents`
（编号 `DOC-001…`，文件名形如 `DOC-001_书名.pdf` 时取书名为题名），每个物理页一条 `doc_pages`。

**两条 OCR 路线，一套页级契约**（各自一个 sidecar 进程，`server/app/ocr_worker.py`，协议与 SAM 工作进程相同）：

| 路线 | 适用 | 引擎 | 环境 |
|---|---|---|---|
| `mineru` | 现代横排书籍（默认，`documents.script=modern`） | [MinerU](https://github.com/opendatalab/MinerU) 3.4：版面分析 + 文字 / 表格识别 + 阅读顺序，直接读 PDF，输出带坐标的版面块与裁好的插图；默认 `hybrid-engine`（有文字层直接抽字，扫描页走 MinerU2.5-Pro 1.2B VLM）| `ml/ocr/mineru-venv`（CUDA 12.8 torch，RTX 50 系可用；VLM 需 8 GB 显存），模型从 ModelScope 下到用户缓存 |
| `ndl` | 古籍竖排（`script=classical`） | [NDL-KotenOCR Lite](https://github.com/ndl-lab/ndlkotenocr-lite)：RTMDet 版面 + PARSeq 识别 + 古典籍阅读顺序，ONNX CPU，约 2 s/页 | `ml/ocr/ndl-venv` + 引擎目录 `ml/ocr/ndlkotenocr-lite/src`（含 80 MB 模型） |

选型依据（2026-09 调研）：OmniDocBench v1.6 榜首是 NaviDC-OCR / OvisOCR2 / PaddleOCR-VL-1.6 这类端到端小 VLM（96–97 分），
但它们要 vLLM（Windows 不支持）且只输出 Markdown；MinerU 95.4 分，Windows 原生、Blackwell 可用、输出**段落级坐标与图注绑定**，
正是我们做引用锚点与插图抠取所需。古籍路线沿用《齐鲁文化基因解码》工程的评测结论，只保留 NDL Lite。

一键建环境：`.\scripts\setup_ocr_envs.ps1`（uv + Python 3.12；约下载 5 GB）。

**落库**（`server/app/services/library.py`）：每页 OCR 后写 `segments`（文段：正文 / 标题 / 图注 / 脚注 / 页眉 / 页码 / 表格 / 古籍行，
`bbox` 归一化坐标，`text` 机器底稿只读，`text_edit` 人工校订稿，`revision` 并发保护）与 `figures`（插图裁片 + 图注 + 图号如"图版2.34"），
页面全文进 `doc_pages.text`，同时维护 FTS5 trigram 索引 `segments_fts`。

**全库检索**（`services/library.search`）：检索的是 OCR 文本（有校订稿时以校订稿为准），跨所有已入库的书。空白分词、多词为「且」；
每个词都 ≥3 字时走 FTS5 trigram 索引，否则退回 LIKE 子串匹配；结果按 **书 → 页 → 段** 的阅读顺序排列并支持 `offset` 翻页，
同时返回总数与各书命中数（`facets`，不受 `document_id` 过滤，前端用作书签筛选），命中片段用 `[[ ]]` 标出命中词。
原始输出留在 `server/data/library/doc<id>/ocr/`，页图缓存在 `pages/`（浏览 150 DPI，OCR 输入 300 DPI 并记 SHA-256）。

**物理页与跨页段落**：MinerU 的 `content_list` / `para_blocks` 面向连续阅读，会把下一页续文并入上一页，
并将原页标为 `lines_deleted`；不能直接用于逐页校勘。工作进程通过 `ocr_normalize.py` 读取
`middle.json` 的 `preproc_blocks`，按物理页、原版面块顺序和本页坐标保存，图注与脚注保留独立边界。
页索引缺失、重复或不在请求范围时返回错误，不将缺失结果当作完成。归一化版本记在
`doc_pages.stats.ocr_normalization`。重新识别按文字与位置匹配旧段，保留段ID、人工校订与审核；
未能可靠匹配的人工记录继续保留，并记入 `stats.retained_review`。

旧缓存可在 OCR 队列空闲时无模型修复：`python scripts/repair_ocr_physical_pages.py` 先预览，
加 `--apply` 后自动备份 SQLite 到 `server/data/library/repairs/<时间>/`，再重建已完成的 MinerU 页面及索引。
原始OCR文件不修改；已应用同版本的页面自动跳过。更新代码后须重启后端及其 OCR 工作进程，
浏览器刷新只会重新载入页面数据。回归验证：`python scripts/test_ocr_normalize.py` 和
`python scripts/test_library_reconciliation.py`，无需启动模型或写入实际资料库。

**全库顺序 OCR**：后端每次处理一本书；运维脚本自动按体例选择引擎并依次提交所有文献。
先重启后端，使最新代码进入后端和 OCR 工作进程，再从项目根目录执行：

```powershell
python scripts/run_library_ocr.py --redo --state server/data/library/ocr-queue.json
```

`--redo` 包含已经完成的页；省略时只处理未完成页。脚本运行期间应保持进程开启，进度写入指定 JSON 文件，
书库界面会自动发现当前作业和下一本书。点击界面「取消」会停止当前作业与后续队列。
中断后用 `python scripts/run_library_ocr.py --resume --state server/data/library/ocr-queue.json` 恢复同一队列；
恢复时跳过本轮已完成的页。若后端也重启或启动请求的响应丢失，脚本会停止并记录原因，需先核对作业状态。
原有校订与审核按上述匹配规则保留。完整重跑前建议备份数据库，
OCR 原始输出会随重新识别更新。队列回归测试：`python scripts/test_library_ocr_queue.py`。

**接口**（`/api/library/…`）：`POST scan` · `GET/PATCH documents[/{id}]` · `GET documents/{id}/pages` · `GET documents/{id}/file` ·
`GET pages/{id}`（文段 + 插图）· `GET pages/{id}/image?dpi=` · `POST documents/{id}/ocr`（`engine / pages / redo / backend`，后台逐页落库）·
`GET ocr/status` · `POST ocr/cancel` · `PATCH segments/{id}`（`text_edit / kind / review_status / base_revision`）· `PATCH figures/{id}` ·
`GET figures[/{id}/image]` · `GET search?q=&document_id=&limit=&offset=`（返回 `total / hits / facets`）。
验证：`python scripts/verify_library.py --engine ndl --pages 16`；不经后端直接试引擎：`python scripts/ocr_worker_smoke.py mineru <PDF> 16 17`。

**书库界面**（文献模块 → 「书库」页签，深链 `#p=library&lib=books&doc=1&pg=16&q=西王母`）：

- 左栏顶部是**全库检索框**（吸顶）：输入两字起即搜（防抖 350 ms），一字需回车，Esc 清空；有输入时检索结果接管整栏，
  按书分组、每条显示页码与高亮片段，多本书命中时出现各书的书签可筛选，「更多」翻页。点一条命中直达那本书的那一页，
  校勘台自动选中该文段并滚到可见，检索词在文段卡片里高亮；深链的 `doc / pg / q` 随浏览实时回写，刷新即回到原处。
- 检索框之下是**选书下拉**（同样吸顶）：按钮上是当前书的编号 / 题名 / OCR 进度，展开后列出全部书目并可按编号 / 题名 /
  作者 / 年份筛选，每本带页数、进度、文段 / 插图数、体例、类型、是否正在 OCR；书多了也不必上下滚动。再往下是所选书的
  文献信息（题名 / 作者 / 年份 / 体例 / 类型）、OCR 作业（引擎、MinerU 后端、页范围、重做开关、开始 / 取消、工作进程状态、
  进度；作业属于另一本书时标出其编号）、按状态着色的页格。
- 右侧是逐页校勘台：原刊页图叠版面块（按类别配色，插图红色虚线）| 插图卡与文段卡（类别、机器 / 已校 / 否决三态，
  机器底稿只读，展开写校订稿，Ctrl+S 保存，`base_revision` 乐观锁）。

下一步：证据表（节点 ↔ 文段 / 插图）、释文与原书页的自动对齐、图版页竖排图注的补漏。

## 五、素材与释文的准备（每块石头）

1. 在 `assets/stones/` 建 `编号_名称` 目录（如 `WS-007_前石室东壁`）；
2. 全幅照片放 `photos/`，局部照片放 `photos/` 下任意子文件夹，拓片放 `rubbings/`，
   三维放 `models/high|mid|low/`（界面只展示低模，高模 / 中模仅登记归档）；
3. `meta.json`（可选，UTF-8）：

   ```json
   {
     "code": "WS-007", "name": "前石室东壁",
     "era": "", "material": "", "carving": "", "dims_text": "", "location": "",
     "description": "总述释文……",
     "layers": [{ "seq": 1, "name": "第一层名称", "summary": "该层释文……" }]
   }
   ```

4. 重启后端、顶栏「重新扫描」或 `POST /api/scan` 入库；同名文件替换会自动重读尺寸并作废预览缓存
   （**改文件名会被视为删旧增新，旧名下的标注随之删除**）。每块石头保证有一张主图（无则兜底取最高分辨率的全幅照片）。

## 六、数据库

SQLite（`server/data/stonelab.db`），经 SQLAlchemy ORM，启动时自动轻量迁移
（`migrations.py` 以 ALTER 补列；一次性数据修正记录在 `schema_fixes` 表，不会重复执行）。
大文件留在文件系统，库中只存元数据与标注。表：
`stones` / `layers` / `assets`（extra 内含 is_master 与 align_to_master 坐标链）/
`annotations`（结构节点、测量与对齐记录）/ `concepts`（概念词，跨石头共享）/ `annotation_concepts`（节点—概念多对多）。
未来需多人协作时改 `app/config.py` 的 `database_url` 换 PostgreSQL 即可。

## 七、接口

全部接口带 Pydantic 响应模型，启动后访问 **http://127.0.0.1:8020/docs** 查看并直接调试。

| 分组 | 接口 |
|---|---|
| 系统 | `GET /api/health` · `GET /api/stats` · `POST /api/scan[?warm=]` |
| 石头 | `GET /api/stones` · `GET/PATCH /api/stones/{id}` · `PATCH /api/stones/{id}/layers/{seq}` · `GET /api/stones/{id}/annotations`（结构树数据源） · `POST /api/stones/{id}/master/{asset_id}` |
| 结构 | `GET /api/stones/{id}/structure/skeleton`（释文解析预览） · `POST /api/stones/{id}/structure/skeleton`（按选定清单建节点） · `POST /api/stones/{id}/structure/auto-parent`（按几何包含归类） |
| 资产 | `GET /api/assets/{id}/preview` · `GET /api/assets/{id}/thumb` · `GET /api/assets/{id}/preprocessed?mode=&invert=` · `GET /api/assets/{id}/model/{fname}` · `GET /api/assets/{id}/projected` |
| 标注 | `GET /api/annotations?asset_id=` · `POST /api/annotations`（`auto_parent`、`parent_id`、`level`…） · `POST /api/annotations/batch` · `PATCH /api/annotations/batch`（名称/颜色/父级/层级/类别/次序/审核） · `POST /api/annotations/batch-delete` · `PATCH/DELETE /api/annotations/{id}`（含 `semantics`、`concept_ids`、挂接几何） · `GET /api/annotations/{id}/parent-suggestions` · `POST /api/annotations/{id}/adopt` |
| 概念 | `GET /api/concepts/taxonomy` · `GET/POST /api/concepts` · `PATCH/DELETE /api/concepts/{id}` |
| 分割 | `GET /api/tools/segment/status` · `POST /api/tools/segment/load|unload/{engine}` · `POST /api/tools/segment/point` · `POST /api/tools/segment/text`（`prompt` / `boxes[]` / `preprocess` / `invert` / `tiling`） |
| 对齐 | `POST /api/align/commit` |

错误统一为 `{"detail": "中文说明"}`：404 不存在、409 图文关联冲突 / 概念重名、422 参数/区间非法 / 父子成环。

## 八、脚本（scripts/）

| 脚本 | 用途 |
|---|---|
| `check_encoding.py` | 全项目 GBK→UTF-8 修复、CRLF→LF 统一（仓库策略 `eol=lf`）+ 中文损毁（连续问号）扫描，**改完代码必跑** |
| `patch_utf8.py spec.json` | 按 JSON 规格对 UTF-8 源文件做精确替换（编辑器把新建的中文文件误读为 GBK 时用它改代码） |
| `smoke_ui.py [--dev] [--shots 目录] [--only books,search]` | 用本机 Edge 无头渲染首页与四个模块（含书库、全库检索深链），统计关键 DOM 并可截图 |
| `verify_search_ui.py [截图路径]` | 书库交互验证（Playwright + 本机 Edge）：全库检索深链即搜、点命中直达并高亮、多词 / 一字 / Esc、深链回写；选书下拉展开 / 筛选 / 切换 / 收起 |
| `reset_annotations.py [--all] [--yes]` | 清空结构节点与测量（默认保留对齐记录与坐标链），先自动备份数据库 |
| `seed_skeleton_containers.py [编号]` | 为一块石头只创建骨架的容器节点（整石 / 花纹带 / 层 / 场景），幂等 |
| `verify_structure.py [--preview-only] [--keep]` | 结构树端到端验证：骨架预览/创建、挂接几何、父级建议与自动归类、批量处置、候选并入、成环拒绝、删除上挂 |
| `setup_ocr_envs.ps1 [-Only mineru|ndl]` | 建立两个 OCR 工作环境（uv + Python 3.12）并下载 MinerU 模型 |
| `ocr_worker_smoke.py <engine> <PDF或页图> [页…]` | 不经后端直接驱动 OCR 工作进程，看引擎原始输出 |
| `verify_library.py [--engine] [--pages] [--backend]` | 文献库端到端验证：扫描、页图、OCR 作业、页详情、单书 / 全库检索、校订与 409 |
| `run_library_ocr.py [--redo] [--state 路径] [--resume]` | 全库按体例顺序 OCR，保存队列进度、失败页，支持中断恢复 |
| `repair_ocr_physical_pages.py [--apply]` | 从 MinerU 原始缓存修复跨页续文错位；默认预览，应用前自动备份数据库 |
| `test_ocr_normalize.py` / `test_library_reconciliation.py` / `test_library_ocr_queue.py` | 物理页归一化、重跑保留人工记录、队列调度回归测试 |
| `bench_photo_seg.py [--engine] [--prompt] [--asset]` | 同一张照片上对照 整图/切块 x 原图/增强/仿拓片 的检出数、分数与耗时（需 GPU 环境） |
| `verify_research.py` | 释文关联（字段编辑/图文关联/锁定保护）验证 |
| `verify_frame.py` | 统一坐标系（对齐入链+跨图投影）数学验证，用后自动清理 |
| `verify_master.py` | 主图切换/复原验证 |
| `verify_meta.py` | meta.json 释文入库核验 |
| `verify_sam.py` / `verify_sam31.py` | 分割引擎端到端推理验证（需 GPU 环境） |
| `probe_*.py` · `verify_round2.py` · `fix_css_comments.py` | 诊断与历史修复脚本（留档） |

## 九、当前边界

- 2D 预览为长边 2560 的 sRGB JPEG（首次打开生成缓存；扫描后后台预热）；全分辨率深度缩放需 DZI 瓦片，未做；
- 三维查看用低模；816 MB 高模不进浏览器；三维与照片的坐标打通（相机位姿配准）本轮不做，跨图投影与叠加仅覆盖 2D；
- 测量无比例尺标定：2D 为原图像素，3D 为模型单位；
- 图文关联覆盖总述与各层释文，同一文本源上的关联区间不能重叠：骨架生成时场景 / 人物节点各占一段释文，
  其下的物象、榜题不再自动关联（可手动关联未被占用的句子）；
- 几何包含推断用主图坐标系下的外接矩形，未入链的图上的节点不参与建议与归类；
- 概念是扁平词表 + 固定两级分类，暂无同义合并与概念间关系；文献库已可入库 / OCR / 校订 / 全库检索，
  但节点与文段的证据链、观点综合属后续阶段；全库检索是精确子串（trigram），暂无繁简 / 异体字归一与语义检索。

## 十、开发注意

- 本机编辑器写入含中文的**新文件**可能落成 GBK 编码，且对含中文文件做局部替换也可能改变编码。
  约定：**每次改完代码立即运行 `python scripts/check_encoding.py`**；该脚本会自动转码并在发现
  "连续问号"式损毁时以非零码退出。此外避免在含中文的文件里使用 GBK 之外的符号
  （如 U+2218 复合算符、U+2713 对勾、U+26A0 警告号、emoji），它们会在转码中变成问号。
  仓库内的 `.editorconfig` 与 `.vscode/settings.json` 已把编码钉为 UTF-8，新环境一般不会再遇到。
- 上述转码之后，编辑器工具对**它自己新建过的文件**仍按 GBK 处理：读出来是乱码、精确替换找不到原文，
  更糟的是替换成功时会把整个文件按 GBK 写回（再转码一次就变成一片问号）。对这类文件一律不用编辑器改：
  写一个 `{"file": ..., "edits": [{"old": ..., "new": ...}]}` 规格，运行 `python scripts/patch_utf8.py spec.json`
  （规格文件本身 UTF-8 / GBK 均可），或整文件重写后立刻跑 `check_encoding.py`。一旦发现损毁，`git checkout -- 该文件` 再重做。
- 前端类型检查：`cd web ; npm run typecheck`；构建：`npm run build`；界面冒烟：`python scripts/smoke_ui.py --shots server/data/shots`。
- zustand 选择器**只能返回原始值或 store 内既有引用**，不能每次返回新数组/对象（会触发无限重渲染，
  整棵树被卸载成黑屏）；派生列表请在组件里 `useMemo`。
- 各面板都包在 `ErrorBoundary` 里：组件抛错只会在该区域显示错误卡片与"重置"按钮，控制台有堆栈。
- 三维查看器卸载时会 `forceContextLoss()` 释放 WebGL 上下文；若浏览器仍回收了上下文，
  画面会提示并提供"重新加载模型"。开发模式下修改 `store/useApp.ts` 会触发整页刷新（避免过期 store）。
- 查看器容器一律 `overflow: hidden`（`.viewport`、`.center`、面板的 `panel-clip`），three.js 用
  `setSize(w, h, false)` 且 canvas 由 CSS 撑满：可拖拽面板的内层默认 `overflow: auto`，画布只要溢出
  1 px 就会弹出滚动条并与 ResizeObserver 形成每帧振荡（整个窗口抖动、模型加载不出来）。
- 后端依赖：`pip install -r server/requirements.txt`；分割环境另见 `server/app/config.py`。

## 十一、版本控制

- 仓库：https://github.com/wahonet/WSC3D ，远程只保留 `main`。旧 WSC3D 项目（v0.2–v0.9）与当前 `main` 没有共同历史，
  其完整提交只保留在本机分支 `legacy/wsc3d`（不推送）；确认不再需要时 `git branch -D legacy/wsc3d`。
- **只上传程序壳子**。不入库：`assets/stones/**`（照片、拓片、三维、**以及 `meta.json` 简介与释文**）、`ml/`、
  `server/data/`（数据库、缓存、日志、截图）、`web/node_modules`、`web/dist`、`_backup/`。
  换机器时把 `assets/stones/`、`ml/`、`server/data/stonelab.db` 三处单独拷贝即可复原。
- 本机 git 全局配置了代理 `127.0.0.1:18081`；代理未开时推送需临时绕过：
  `git -c http.proxy= -c https.proxy= push origin main`。
