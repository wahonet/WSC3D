# 武氏墓群石刻数字档案与图像研究平台

面向武氏墓群石刻的公开展示、图像研究与文献整理平台。文物档案、照片、拓片、三维模型、图像标注和文献出处通过稳定的文物编号关联，公开展示与研究工作台使用同一份资料。

项目提供 Windows 64 位便携运行环境，支持本机使用、办公室局域网协作及离线研究成果交接。基础浏览和人工研究可在本地完成，在线问答、生图及视频生成使用单独配置的服务。

## GitHub 仓库与完整项目

GitHub 仓库保存程序源码、回归测试、项目配置、运行包校验清单和本说明。原始文物与文献资料、原图资源压缩包、研究数据库、模型权重、运行环境压缩包、前端构建产物、日志及本机 API 配置保留在完整本地项目中，不随源码提交。

下方的双击启动与整目录迁移步骤适用于完整项目。仅克隆 GitHub 仓库尚不能直接运行：需从完整项目副本补齐 `resources`、`data`、`models`、`runtime/resource-packs`（如已收纳原图）和与校验清单匹配的 `runtime/runtime.zip`、`runtime/development.zip`，再运行 `tools/构建前端.bat` 生成 `build/web`。在线服务配置在工作台重新填写。

## 快速开始

将完整项目放在本机可写目录，双击根目录的 `启动平台.bat`。浏览器默认打开 [本地平台](http://127.0.0.1:8030/)。首次启动会校验运行包并解压到 `%LOCALAPPDATA%\WSC-Unified`，后续复用缓存，无需另外安装系统 Python 或 Node.js。

| 操作 | 入口 |
| --- | --- |
| 本机启动 | `启动平台.bat` |
| 局域网启动 | `启动平台（局域网）.bat` |
| 停止平台与项目模型服务 | `tools/停止平台.bat` |
| 西长廊摆放 | `tools/打开西长廊摆放工具.bat` |
| 后展厅摆放 | `tools/打开后展厅摆放工具.bat` |
| 原版三维查看器 | `tools/打开原版三维查看器.bat`，默认端口 8040 |

首页默认进入公开展示。点击右上角登录入口进入研究工作台，默认账号为 `admin`，默认密码为 `123456`。可通过环境变量 `WSC_WORKSPACE_PASSWORD` 指定密码，启动、停止和命令行维护工具应使用同一设置。平台重启后需要重新登录。

局域网模式下，在主机用 `ipconfig` 查看当前 IPv4 地址，其他设备访问 `http://主机IPv4地址:8030/`。首次启用可能需要确认 Windows 防火墙配置，主机须保持开机并运行平台。需要恢复为仅本机访问时，先停止平台，再使用普通启动入口。默认端口登记在 `config/project.json`。

## 功能与使用

| 模块 | 主要用途 |
| --- | --- |
| 文物档案 | 查阅身份卡、照片、拓片、三维模型、已审图像解读及文献出处 |
| 院落全景 | 浏览院落和展厅、定位文物、查看空间关系 |
| 图像研究 | 测量、图像对齐、SAM 分割、结构标注、文献举证、档案维护和资源扫描 |
| 文献中心 | 阅读核心十书和扩展文献，执行 OCR、校订文段、查阅插图与图像引用 |
| 知识图谱 | 浏览故事、人物、物象及其关系，回查候选所依据的原书页 |
| AI 问答 | 根据本地文献检索、重排和逐石底本回答问题，并提供出处 |
| 电子文创 | 发布图案与视频素材，制作明信片、壁纸、纪念卡和透明贴纸；下载和分享作品 |
| API 配置 | 配置在线问答、图像生成和视频生成服务 |

### 图像标注与文献举证

1. 在“图像研究”选择文物和底图，通过手工绘制或分割取得区域；新绘制和分割结果先作为候选保存。
2. 在“结构标注”选中区域，填写名称、概念和描述；可选择相关故事、人物或物品，挂接题材及其文献。
3. 展开关联文献，选择原文并填入直观描述或故事描述。系统同时保存原书、页码、文段身份和摘录位置。
4. 点击“保存”或按 `Ctrl+S` 提交。正常保存后成为已审标注，并可出现在对应公开档案的图像解读中；未提交草稿不等于已保存成果。

“文献举证”用于查找本石关联原文、同题讨论及全库文字，点击页码可进入文献中心。文献页中的“关联图像”可返回引用该页的标注。

几何保存会检查形状、点数、维度和数值。遇到无效几何提示时，应修正区域再提交；历史坏几何不会阻断其他有效区域的投影和显示，原记录仍保留供核查。

### 文献整理与布局编辑

在文献中心打开 PDF 原页，选择合适的 OCR 引擎，识别后核对文字与插图并进行人工校订。重新 OCR 时，系统会协调既有人工内容和引用；未能可靠匹配的记录保留供复核。

文段校订与展厅布局均有版本冲突检查。多人同时处理同一内容时，若提示已被修改，应先保留自己的调整，再读取最新内容。西长廊摆放工具可先“导出JSON”备份草稿，再“读取系统布局”继续调整。摆放完成后须点击“应用到系统”或“保存到主平台”，浏览器自动保存的草稿尚未应用到平台。

### 问答、分割与文创

本地模型包括 SAM3、SAM3.1、MobileSAM 图像分割，RapidOCR、NDL、MinerU 文字识别，以及 BGE 检索、重排和 Ollama 本地问答。模型路径及路由登记在 `config/models.json`，实际可用方式取决于本机环境、显卡与驱动。

问答依据当前已登记文献与底本提供证据，原书缺失、OCR 不完整或候选未确认时，需要回查原页。问答结果目前不作为服务器端研究历史自动保存。

工作台中的“视频生成、图像生成、素材发布”负责准备和发布文创素材。在线问答、MiniMax 视频及 Seedream 生图分别配置；准备底图和预览不会提交付费生成任务，点击生成后才会请求对应服务。生成内容属于艺术演绎，发布后可供访客制作作品，不自动成为已审研究结论。更换电脑或 Windows 账户后，在线密钥需要重新配置。

访客作品与当前浏览器身份关联，应下载需要保留的成品或保存分享链接。局域网分享应使用主机的局域网地址生成链接。

## 文件与数据

| 位置 | 内容 |
| --- | --- |
| `src/backend/app` | FastAPI 接口、SQLite 数据模型和研究业务逻辑 |
| `src/frontend` | React / TypeScript 界面及静态资源 |
| `src/engines` | OCR 等引擎源码和配套组件 |
| `build/web` | 平台实际使用的前端构建产物 |
| `resources` | 文物原件、文献、三维场景、文创素材和制作工程 |
| `models` | 本地模型权重与配置 |
| `runtime` | 运行包、开发工具包、原图资源压缩包及校验清单 |
| `data` | 研究数据库、OCR 成果、保存的布局、索引和交接状态 |
| `config` | 项目设置、稳定编号、资源映射与模型路由 |
| `tools` | 启停、构建、交接、数据维护及制作工具 |
| `tests` | 保留的单元、集成、前端及模型回归测试和夹具 |
| `logs`、`tmp` | 运行日志与临时工作文件 |

画像石素材按 `resources/stones/<名称>__<编号>/` 整理，目录下的 `images`、`models`、`metadata`、`notes` 和 `versions` 分别保存影像、模型、元数据、研究记录及固定底图版本。名称便于查找，`武011` 等稳定编号用于维持业务关联。

主要数据位置：

- `data/stonelab.db`：档案、标注、引用、文献与校订数据。
- `data/creative.sqlite3`、`data/creative/works`：文创记录与访客成品。
- `data/library`、`data/layouts`：OCR 成果、插图与已应用布局。
- `data/handover.json`、`data/backups`：交接基线与恢复备份。
- `resources/documents/core`、`resources/documents/extension`：核心与扩展文献。
- `resources/creative/materials`、`resources/videos`：已制作素材、视频与来源证据。
- `data/index`：检索及逐石文献关联的派生索引。

研究数据、原件及 `versions` 底图快照应随项目保留。素材的部分逻辑路径通过 `config/resource-aliases.json` 指向实体文件，移动或改名须同时维护映射和数据库登记。清理临时目录前，应先结束相关作业，并确认其中没有尚未保存的成果。

### 集中存放的参照资料

报告、原始测绘图和现场参照资料统一放在 `resources/reference`，按用途查找：

| 位置 | 内容 |
| --- | --- |
| `resources/reference/报告与说明` | 定级报告、名录与尺寸说明、广陵书社画面说明 |
| `resources/reference/测绘与CAD` | 院落、展厅和周边环境的原始 DWG、DXF、CAD 导出 PDF 与平面示意图 |
| `resources/reference/现场参考照片` | 按展厅、院落部位和周边环境分组的原始参照照片 |
| `resources/reference/演示资料` | 广陵书社提供的三个原始 PPTX，保留图片、文字和原始编排 |

这些原件应随完整项目复制。旧导入路径与测绘来源路径已通过资源映射兼容，档案中的报告、演示资料链接和制作脚本仍能读取原件；无需手动修改历史来源记录。以后新增同类资料优先放入以上分类，改动已登记文件的位置时应同步维护资源映射。

`resources/reference/viewers` 保留仍在使用的原版三维查看器。建模转换得到的 DXF、分析结果和制作中间文件继续保存在 `resources/authoring` 对应工程中；文物研究底图和文献中心原书分别保存在 `resources/stones` 与 `resources/documents`。

### 原图无损收纳

石刻目录 `images` 和 `versions` 下的 TIFF 可无损收纳到 `runtime/resource-packs`，按文物保存为标准 ZIP64 包。包中保留原文件的完整字节；清单记录逻辑路径、SHA-256、原始时间和图像尺寸。压缩工具逐个解压校验成功后才移除对应散文件，不转码、不降低像素或位深。模型贴图、预览图、文献、制作工程和研究数据库保持原存储方式。

收纳后的项目可直接启动。平台、资源扫描、研究底图、素材来源和交接工具通过原逻辑路径访问资料；原图首次使用时自动校验并解压到本机缓存。默认缓存位于 `%LOCALAPPDATA%\WSC-Unified\cache`，无需随项目复制。首次读取大图可能稍慢，本机缓存会随使用增长。完整资源检查会校验压缩包指纹，不会把全部原图解压到项目内。

原图资源包属于必须随项目保留的资料，不能当作临时安装包删除。资源文件夹中看不到已收纳的 TIFF 散文件属于正常情况；需要直接在其他软件中批量操作原文件时，可以恢复原始目录。新放入同一逻辑路径的散文件优先使用，仍须在工作台执行资源检查来确认是否替换已有底图。

以下命令在项目根目录运行。查看计划可随时执行；实际收纳或恢复前先保存研究内容并运行 `tools/停止平台.bat`，完成后用原启动入口重新启动。

```powershell
# 查看尚可收纳的原图与已有压缩包
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tools/compact_resources.py

# 校验后收纳；中断后可以再次执行
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tools/compact_resources.py --apply --workers 4

# 恢复原始散文件，校验后移除不再使用的压缩包
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tools/compact_resources.py --restore
```

两端使用相同版本程序时，散文件与已收纳目录之间仍可顺序交接；收纳本身不改变研究文件指纹或交接基线。恢复原图需要为展开后的原始文件预留磁盘空间，已有不同内容的散文件不会被恢复命令覆盖。

## 增加资料与迁移

已有文物的新照片放入对应 `images/photos`，新拓片放入 `images/research-rubbings`，使用新的文件名。复制完成后，在“图像研究 → 档案维护”执行“重新扫描”或“批量扫描”登记。需要核查重命名、缺失或替换文件时，使用“检查资源”。新文物还需登记稳定编号及身份卡。

新文献放入 `resources/documents/extension`，完成书目与 PDF 登记，再进行文本提取、OCR 和校订。模型权重放入 `models` 后，还需配置运行环境和调用入口才能使用。

### 首次复制到另一台电脑

1. 保存成果，等待计算任务结束或取消任务，运行 `tools/停止平台.bat`。
2. 将整个项目目录复制到目标电脑的本地可写磁盘，包括 `resources`、`models`、`runtime`、`build` 和 `data`。
3. 保留现有 `data/handover.json`，双击 `启动平台.bat`，等待首次环境准备完成。

通过 U 盘传递完整目录时使用 exFAT 或 NTFS，项目包含超过 4 GiB 的单文件。目标电脑需要给项目和本机环境缓存预留空间；本机缓存无需从旧电脑复制。

### 后续交接研究修改

1. 在当前电脑保存成果，运行 `tools/导出研究交接包.bat`，工具会先停止平台并导出 ZIP。
2. 在接收电脑运行 `tools/导入研究交接包.bat`，选择交接包，导入成功后再启动平台。
3. 接收电脑完成下一轮工作后导出新包，其他副本按生成顺序导入。

交接采用顺序接力，同一时间由一个离线副本继续编辑。独立修改产生冲突或跳过前一份包时，导入会停止。包内包含研究数据库及相关改动，不包含日常未变更的全部资源、程序源码、模型权重、运行环境和在线密钥；程序或模型升级需另行同步两端版本。

导入前的备份位于 `data/backups/handover-*`。交接包不能代替定期完整备份，复制完整项目或制作恢复备份时应先正常停止平台。

## 开发与维护

版本为 2.0.0。前端使用 React、TypeScript 和 Vite，后端使用 FastAPI、SQLAlchemy 和 SQLite。普通运行使用 `build/web`，修改前端源码后需执行 `tools/构建前端.bat`，再刷新页面；修改后端后需停止并重新启动平台。

构建工具从 `runtime/development.zip` 准备 Node.js 和依赖，放在本机缓存中。开发与测试命令应在项目根目录执行，使用 `tools/run.ps1` 选择配套环境，例如：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tests/test_annotation_geometry.py
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tests/test_segment_concurrency.py
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tests/test_xcl_layout_concurrency.py
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tests/test_geometry_rendering.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tests/test_xcl_placement.mjs
```

上述回归覆盖几何校验、历史坏数据、并发校订、布局版本、前端显示及草稿保存；写入检查使用临时数据库或临时布局文件。其他模型和集成测试按各脚本参数在隔离数据上执行，避免把试验数据混入正式研究库。

制作工具位于 `tools/authoring`，配方登记在 `config/authoring-recipes.json`。Blender 仅在修改或导出相关制作工程时需要，浏览平台无需安装。

## 图谱与展示资料约定

图谱候选保存在 `config/knowledge-graph/core10-candidates.v1.json`，附原文摘录和持久来源身份。候选提供待核线索，OCR 文段已校订不等于其历史释读已确认；无法唯一映射文物的关联不会强行创建图像标注。同一题材可以关联多个图像区域，各区域保留自己的形状、底图和引用。

摘录保存时会核对来源、归属、字符位置与正文。原文变化或来源不可用时保留记录供核查。维护人员可运行以下只读来源校验，结果输出到 `logs/knowledge-validation.json`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tools/validate_knowledge_candidates.py
```

`resources/sources/KnowledgeGraph` 是研究参考仓库，不属于平台运行依赖。第三方引擎、参考资料附带的说明及许可保留在各自目录；项目使用与维护说明统一在本 README。

首页正门插画位于 `src/frontend/public/brand/museum-gate.webp`，由用户提供的博物馆实景照片转绘为淡彩建筑线描，用于展示，不作为建筑测绘或历史复原依据。原始文献、拓片、艺术衍生图与已审研究内容保持各自的来源属性。

## 常见问题

| 情况 | 处理方式 |
| --- | --- |
| 双击启动后尚未打开页面 | 首次环境准备需要时间；失败时查看启动窗口及 `logs/platform.log` |
| 提示端口由另一份平台占用 | 先正常停止原目录的平台，再启动当前目录 |
| 局域网设备无法访问 | 核对主机地址、局域网启动方式及 Windows 防火墙配置 |
| 写入时要求登录 | 重新登录工作台；平台重启会使原会话失效 |
| 保存文段或布局时提示冲突 | 保留当前调整，读取最新版本后重新核对并提交 |
| 修改前端后页面仍是旧内容 | 运行 `tools/构建前端.bat`，完成后刷新浏览器 |
| 换电脑后模型或在线服务不可用 | 核对完整模型与运行包、目标机驱动，并重新填写所需在线密钥 |
