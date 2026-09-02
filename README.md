# StoneLab · 汉画像石研究平台

面向武氏祠（及后续 40+ 块画像石）的本地研究平台。两个模块：

- **工作台**：浏览高清照片 / 局部 / 拓片 / 三维低模，标注、测量、SAM 分割（GPU 实际推理）、
  左右分屏对应点对齐，并以"主图统一坐标系"实现标注跨图投影；
- **研究模块**：图文关联研究——编辑石头元数据与释文，把图上标注与权威文字双向绑定
  （橙色高亮、锁定保护）。

技术栈：FastAPI + SQLAlchemy + SQLite（后端），React 19 + TypeScript + Vite（前端），
OpenSeadragon（深度缩放）、three.js（三维）、zustand（状态）、react-resizable-panels（可拖拽布局）。

## 一、目录结构

```text
stonelab/
├─ assets/                     素材区（导入新石头只动这里）
│  └─ stones/
│     └─ WS-003_武梁祠西壁/
│        ├─ meta.json          石头信息（era/material/carving/dims_text/location/description/layers）
│        ├─ photos/            全幅高清照片
│        │  └─ 历代帝王（加强版）/   photos 下任意子文件夹 = "局部"分组
│        ├─ rubbings/          拓片
│        └─ models/high|mid|low/   各一套 obj + mtl + 贴图（界面只展示低模）
├─ ml/                         分割模型权重
│  ├─ mobilesam/mobile_sam.pt            40 MB   点选分割（CPU）
│  ├─ sam3/sam3.pt                       3.45 GB facebook/sam3 文本分割（GPU）
│  └─ sam3.1/**/sam3.1_multiplex_fp16.safetensors  1.75 GB SAM3.1 文本分割（GPU）
├─ server/                     后端
│  ├─ app/
│  │  ├─ main.py               应用入口：生命周期（建表/迁移/启动扫描）、CORS、异常处理、托管 web/dist
│  │  ├─ config.py             全部路径与参数（环境变量可覆盖）
│  │  ├─ db.py · models.py · migrations.py · schemas.py · constants.py
│  │  ├─ routers/              system / stones / assets / annotations / segment / alignment
│  │  ├─ services/             scanner / previews / alignment / transforms / textlinks / segment / serialize
│  │  └─ sam_worker.py         SAM 推理子进程（独立 Python 环境中运行）
│  ├─ data/                    stonelab.db · previews/（预览、_hires 工作图、pp_ 预处理图）· thumbs/ · sam_worker.log
│  └─ requirements.txt
├─ web/                        前端
│  ├─ src/
│  │  ├─ App.tsx · api.ts · types.ts · styles.css（设计系统）
│  │  ├─ store/                useApp（应用状态与动作） · useToast
│  │  ├─ components/           TopBar / Workbench / Home / StoneTree / InfoPanel / AnnotationPanel / AlignView /
│  │  │  │                     ErrorBoundary / Toaster / ui
│  │  │  ├─ viewer/            Viewer2D / Viewer3D / ViewerBar / AnnotationShapes / useOsd
│  │  │  ├─ tools/             ToolPanel / SegmentPanel
│  │  │  └─ research/          ResearchPage / ResearchViewer / TextCard
│  │  ├─ hooks/useShortcuts.ts
│  │  └─ lib/                  constants / format / geometry（Umeyama 求解、叠加换算、外接矩形）
│  └─ dist/                    npm run build 产物（后端可直接托管，不入库）
├─ scripts/                    校验与运维脚本（见第八节）
├─ _backup/                    重构前源码快照 zip（可删，不入库）
├─ .gitignore · .gitattributes · .editorconfig · .vscode/settings.json   仓库与编辑器约定（UTF-8、LF）
├─ 启动平台.ps1
└─ README.md
```

素材（照片/拓片/三维）、模型权重、数据库与缓存**不进 Git**，仓库只版本化程序与各石的 `meta.json`；
见第十一节。

## 二、启动

```powershell
.\启动平台.ps1          # 开发模式：后端 8020 + Vite 前端 5173（热更新），自动打开浏览器
.\启动平台.ps1 -Prod    # 生产模式：构建前端后由后端单进程托管，访问 http://127.0.0.1:8020/
```

或手动：

```powershell
cd server ; python -m uvicorn app.main:app --host 127.0.0.1 --port 8020    # 后端（接口文档 /docs）
cd web    ; npm install ; npm run dev                                       # 前端 → http://127.0.0.1:5173
cd web    ; npm run build                                                   # 构建后后端自动托管 web/dist
```

全部服务只绑定 127.0.0.1。数据（标注、对齐、主图、编辑内容）都在
`server/data/stonelab.db`，重启不丢；整个 stonelab 文件夹拷走即完成备份。
后端**启动时自动扫描**素材目录并在后台预热预览缓存；顶栏「重新扫描」可随时手动触发。

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

## 三、工作台（模块一）

**布局**：顶栏（模块切换、面包屑、重新扫描、接口文档、深/浅色主题）；左侧「画像石」树
（可搜索，带缩略图与主图/链徽标）与「工具」面板；中央查看器（照片/拓片走 OpenSeadragon，
三维低模走 three.js，附缩放/适应窗口按钮与光标原图像素坐标）；右侧「简介与释文」与「标注」。
三栏及上下分区**可拖拽调整**，布局自动记住。未打开素材时中央显示全库统计与操作指引。
地址栏 `#a=<资产id>` 记录当前打开的素材，刷新后自动恢复；`&p=research` 进研究模块，
`&t=<工具>&e=<引擎>` 仅在启动时读取（如 `#a=5&t=segment&e=sam3` 直接打开分割面板）。

**工具与快捷键**：

| 工具 | 键 | 2D（照片/拓片） | 3D（低模） |
|---|---|---|---|
| 选中 | `V` / `Esc` | 点击图形或列表项高亮 | 点击标注球高亮 |
| 标注 | `A`，形状 `1`/`2`/`3` | 矩形（拖拽）/ 多边形（连点、双击闭合、Esc 取消）/ 点 | 表面放置标注点 |
| 测量 | `M` | 两点原图像素距离 | 两点模型单位距离（**未标定，不得当厘米**） |
| 分割 | `S` | 点选（MobileSAM）/ SAM3 / SAM3.1 文本，见下 | — |
| 对齐 | `L` | 左右分屏对应点配准，见下 | — |
| 适应窗口 | `F` | 视图复位 | 相机复位 |
| 删除 | `Del` 两次 | 删除选中标注（面板内删除需二次确认） | 同 |

**标注面板**：按 全部/标注/测量/分割/对齐 过滤；选中后可 **定位**（视图飞到该标注）、
改名（或双击名称）、换颜色（18 色调色板）、删除。

**颜色**：新建标注（手画或批量保存分割候选）自动从调色板中分配当前图上用得最少的颜色，
相邻标注互不相同；跨图投影沿用各标注自身颜色（点划线只表示"投影"）。「自动配色」可给本图
全部标注按调色板重新分配（会覆盖手动选的颜色）；正红保留给选中态、橙色保留给已图文关联。

**图层**（工具面板底部）：标注与测量 / 分割图层（虚线）/ 跨图投影（点划线）三个开关，
以及对齐叠加的透明度。

**分割**：三个引擎——点选（MobileSAM，CPU）、SAM3 / SAM3.1（文字与示例框概念分割，GPU）。
模型按需加载/卸载（卸载即释放显存）。推理运行在独立 Python 环境的 sidecar 进程中
（含 CUDA torch 与 sam3/mobile_sam 包），路径不存在时设 `STONELAB_SAM_PYTHON`。

- 点选：单击加正点、`Alt`+单击加负点，可撤销上一点；
- SAM3 / SAM3.1 的四组选项，专为"拓片能识别、照片识别不出"的域差距而设：
  - **提示方式**：文字（预设人物/马/车/鸟/龙/鱼/树/文字，或手输英文概念词）；
    **文字 + 示例框**——在图上拖拽框住一个典型目标作正例（`Alt` 拖拽为负例），模型按
    "这块石头上的人长什么样"找同类，与文字叠加效果最好；纯示例框可用但噪声偏多；
  - **预处理**：原图 / 增强（去光照渐变 + CLAHE）/ 仿拓片（再自适应二值化成黑底白图形，
    光照相反时勾"反相"）；"查看预处理图"可把查看器切到模型实际看到的图；
  - **推理范围**：整图 / 切块 2560 / 切块 5120。SAM3 内部把整图缩到 1008 px，全幅照片里
    每个人物只剩几十像素；切块模式 = 整图一遍（负责大目标）+ 约 1024 px 切块各一遍
    （负责小目标），结果按掩膜包含关系合并，块状伪检出自动过滤。示例框的特征来自本图，
    有示例框时按整图推理；
  - **阈值**：默认 0.10（照片建议 0.05–0.2 起试）。注意旧版存在缺陷：模型内部按 0.5 先过滤，
    界面阈值低于 0.5 的部分从未生效，现已修正——这是"照片一个也识别不出"的主要原因之一。
- 候选掩膜为青色虚线并标注分数，**点击可剔除 / 恢复**；保存时只保存未剔除的候选，
  一次批量进入"分割图层"，`note` 中自动记 `machine_proposal`、分数、预处理与切块参数——
  机器候选须人工核对。`scripts/bench_photo_seg.py` 可在一张照片上对照各配置的检出数与耗时。

**对齐与统一坐标系**：

- 每块石头有一张**主图**（坐标系原点，红色"主图"徽标）。扫描时自动兜底指派
  （最高分辨率全幅照片），可在查看器顶栏"设为主图"手动更换——已有坐标链时自动重定基，
  新主图未对齐时拒绝切换以保护既有对齐；
- 对齐工具：左键取点（左红右蓝交替编号）、右键拖图、滚轮缩放；配对列表可逐对删除、
  悬停黄圈联动；最少 4 对、至多 20 对，实时 RMSE（绿/黄/红提示精度）；"确定对齐"求解
  相似变换（Umeyama 最小二乘）并保存；
- 配对双方任一已连主图，另一方自动**接入坐标链**（绿色"链"徽标），链可传播；
- **跨图投影**：默认开启（图层栏可关，偏好会记住），同石其他已入链图上的标注以点划线
  （沿用各自颜色）投影到当前图，悬停显示来源——在主图上做的标注会自动出现在所有已对齐的照片/拓片上；
- 对齐记录存于标注列表，点选即可重新应用叠加（透明度可调）。

## 四、研究模块（模块二）

入口：顶栏「研究」标签，或简介面板右上「研究」按钮（需先选中石头）。从工作台带着一张
已入链的图进入时，直接在该图层上打开。三栏可拖拽：

- **左侧 · 标注栏**：当前图层可见的全部标注——本图层自有的，加上其他已入链图层（通常是主图）
  **投影**过来的（带"投影"徽标）；可按名称/内容筛选、按已关联/未关联过滤；下方是编辑区
  （改名、填写内容、定位、取消关联）；
- **中间 · 图像**：顶栏切换**已对齐入链**的图层；图上显示自有标注（实线）与投影标注（点划线，
  沿用各自颜色），点击均可选中；右上缩放按钮；
- **右侧**：石头信息（尺寸/年代/材质/刻法/位置，改后出现"保存信息"）；简介与释文
  （总述 + 各层释文，逐段编辑）；
- **图文关联**：选中标注（自有或投影的都可以）→ 在任一段落中拖选文字 → "关联到「标注名」"→
  文字变**橙色高亮并锁定**，标注内容即该段文字。点橙色文字可反选标注；"取消关联"解绑。
- **锁定保护**：编辑文本时删改任何已关联文字会被拒绝保存（409）；其他改动正常保存，
  且全部关联区间的偏移自动重定位；两个标注的关联区间不允许重叠。

注意：为保护人工编辑，**重新扫描不再用 meta.json 覆盖已有文字字段**
（仅在字段为空时填入）；分层释文（layers）只在库中尚无分层时播种。

## 五、导入新石头（未来 40+ 块）

1. 在 `assets/stones/` 建 `编号_名称` 目录（如 `WS-007_前石室东壁`）；
2. 全幅照片放 `photos/`，局部照片放 `photos/` 下任意子文件夹，拓片放 `rubbings/`，
   三维放 `models/high|mid|low/`（界面只展示低模，高模/中模仅登记归档）；
3. 可选 `meta.json`：`era / material / carving / dims_text / location / description /
   layers[{seq,name,summary}]`；
4. 重启后端、顶栏「重新扫描」或 `POST /api/scan` 入库；同名文件替换会自动重读尺寸并作废
   预览缓存（**改文件名会被视为删旧增新，旧名下的标注随之删除**）。

## 六、数据库

SQLite（`server/data/stonelab.db`），经 SQLAlchemy ORM，启动时自动轻量迁移
（`migrations.py` 以 ALTER 补列）。大文件留在文件系统，库中只存元数据与标注。表：
`stones`（含 carving）/ `layers` / `assets`（extra 内含 is_master 与 align_to_master 坐标链）/
`annotations`（几何用 0..1 归一化坐标；`desc_source/desc_start/desc_end/desc_text` 为图文关联）。
未来需多人协作时改 `app/config.py` 的 `database_url` 换 PostgreSQL 即可。

## 七、接口

全部接口带 Pydantic 响应模型，启动后访问 **http://127.0.0.1:8020/docs** 查看并直接调试。

| 分组 | 接口 |
|---|---|
| 系统 | `GET /api/health` · `GET /api/stats` · `POST /api/scan[?warm=]` |
| 石头 | `GET /api/stones` · `GET/PATCH /api/stones/{id}` · `PATCH /api/stones/{id}/layers/{seq}` · `GET /api/stones/{id}/annotations` · `POST /api/stones/{id}/master/{asset_id}` |
| 资产 | `GET /api/assets/{id}/preview` · `GET /api/assets/{id}/thumb` · `GET /api/assets/{id}/preprocessed?mode=&invert=` · `GET /api/assets/{id}/model/{fname}` · `GET /api/assets/{id}/projected` |
| 标注 | `GET /api/annotations?asset_id=` · `POST /api/annotations` · `POST /api/annotations/batch` · `PATCH /api/annotations/batch`（批量改名称/内容/颜色） · `PATCH/DELETE /api/annotations/{id}` |
| 分割 | `GET /api/tools/segment/status` · `POST /api/tools/segment/load|unload/{engine}` · `POST /api/tools/segment/point` · `POST /api/tools/segment/text`（`prompt` / `boxes[]` / `preprocess` / `invert` / `tiling`） |
| 对齐 | `POST /api/align/commit` |

错误统一为 `{"detail": "中文说明"}`：404 不存在、409 图文关联冲突、422 参数/区间非法。

## 八、脚本（scripts/）

| 脚本 | 用途 |
|---|---|
| `check_encoding.py` | 全项目 GBK→UTF-8 修复 + 中文损毁（连续问号）扫描，**改完代码必跑** |
| `smoke_ui.py [--dev] [--shots 目录]` | 用本机 Edge 无头渲染首页/2D/3D/研究页，统计关键 DOM 并可截图 |
| `bench_photo_seg.py [--engine] [--prompt] [--asset]` | 同一张照片上对照 整图/切块 x 原图/增强/仿拓片 的检出数、分数与耗时（需 GPU 环境） |
| `verify_research.py` | 研究模块（字段编辑/图文关联/锁定保护）验证 |
| `verify_frame.py` | 统一坐标系（对齐入链+跨图投影）数学验证，用后自动清理 |
| `verify_master.py` | 主图切换/复原验证 |
| `verify_meta.py` | meta.json 释文入库核验 |
| `verify_sam.py` / `verify_sam31.py` | 分割引擎端到端推理验证（需 GPU 环境） |
| `probe_*.py` · `verify_round2.py` · `fix_css_comments.py` | 诊断与历史修复脚本（留档） |

## 九、当前边界

- 2D 预览为长边 2560 的 sRGB JPEG（首次打开生成缓存；扫描后后台预热）；全分辨率深度缩放需
  DZI 瓦片，未做；
- 三维查看用低模；816 MB 高模不进浏览器；三维与照片的坐标打通（相机位姿配准）未做，
  跨图投影目前仅覆盖 2D；
- 测量无比例尺标定：2D 为原图像素，3D 为模型单位；
- 跨图投影用的是对齐求得的相似变换（旋转 + 缩放 + 平移）；拓纸伸缩、镜头畸变等局部形变
  会带来像素级偏差，属对齐精度范围（可增加对应点、参考 RMSE）；
- 图文关联覆盖总述与各层释文；分割候选保存后即为普通多边形标注。

## 十、开发注意

- 本机编辑器写入含中文的**新文件**可能落成 GBK 编码，且对含中文文件做局部替换也可能改变编码。
  约定：**每次改完代码立即运行 `python scripts/check_encoding.py`**；该脚本会自动转码并在发现
  "连续问号"式损毁时以非零码退出。此外避免在含中文的文件里使用 GBK 之外的符号
  （如 U+2218 复合算符、U+2713 对勾、U+26A0 警告号、emoji），它们会在转码中变成问号。
  仓库内的 `.editorconfig` 与 `.vscode/settings.json` 已把编码钉为 UTF-8，新环境一般不会再遇到。
- 前端类型检查：`cd web ; npm run typecheck`；构建：`npm run build`；界面冒烟：`python scripts/smoke_ui.py`。
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

- 仓库：https://github.com/wahonet/WSC3D （`main` 为当前程序；旧项目历史保留在 `legacy/wsc3d` 分支）。
- 不入库：`assets/stones/**`（仅保留各石 `meta.json`）、`ml/`、`server/data/`（数据库、缓存、日志）、
  `web/node_modules`、`web/dist`、`_backup/`。如需把标注数据库也纳入备份，把 `.gitignore` 中的
  `server/data/` 改为只忽略 `previews/`、`thumbs/` 与 `*.log`。
- 本机 git 全局配置了代理 `127.0.0.1:18081`；代理未开时推送需临时绕过：
  `git -c http.proxy= -c https.proxy= push origin main`。
