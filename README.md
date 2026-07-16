# 汉画像石数字化研究平台 WSC3D

做汉画像石研究，手上往往同时攥着好几种图：实地采集的高清照片、三维扫描得到的模型、田野传拓的拓片、从模型生成的正射图和法线图。它们看的是同一块石头，却散落在硬盘不同角落，要用不同的软件打开，坐标系也对不齐。WSC3D 想解决的就是这件事——把这些来源拢到同一个工作台上，让研究者能对着同一块画像石，在三维模型、高清原图、拓片之间自由切换，把上面的内容一层层标注下来；标注好的数据又能直接整理成训练集，反过来训练针对汉画像石的识别模型。

整套系统由前端、后端、AI 服务三个本地进程组成，全部跑在 127.0.0.1，数据不离开本机，适合敏感数据不方便上公网的情况，也有助于本地离线研究。

平台现在收敛为两个工作区：**浏览**（单块画像石的多视图查看与测量）和**标注**（图像志级别的标注工作台）。早期版本还有独立的**拼接**（多石组合复原）与**绑定**（高清照片配对）工作台，UI 收敛时已下线——拼接方案数据与 API 仍保留（`.hpsml` 研究包导出会带上相关方案），图片绑定数据仍是高清底图匹配的基础（详见「绑定与图片配对」一节）。标注是花精力最多的部分，也是下面要展开讲的重点。

## 快速开始

```bash
npm install
cd ai-service && pip install -r requirements.txt && cd ..
npm run dev
```

`npm run dev` 用 concurrently 把后端、前端、AI 服务一起拉起来。启动后访问：

- 前端 <http://127.0.0.1:5173>
- 后端 <http://127.0.0.1:3100>
- AI 服务 <http://127.0.0.1:8010>

几个初次使用最好知道的事：

- SAM3 是 Hugging Face 上的 gated 模型。把已授权下载的 `sam3.pt` 放到 `ai-service/weights/sam3/sam3.pt` 就行，这个sam3.pt的权重去哪要就别问我了。SAM3 是平台唯一的 AI 标注入口，首次调用时懒加载。
- 高清原图放进仓库根目录的 `pic/`（已在 .gitignore 里），文件名以画像石编号开头即可，比如 `29东汉武氏祠....tif`。AI 服务会按数字前缀匹配，tif 会在需要时自动转码成 PNG 缓存。历史绑定记录在 `data/pic-bindings.json`，也可以直接调后端 `/api/pic/bind` 完成绑定重命名。
- 装依赖如果想用 GPU 给 SAM3 提速，把 `requirements.txt` 换成 `requirements-cu128.txt`；默认装的是 CPU 版。
- 旧的 MobileSAM 交互分割与 YOLO 批量扫描已从主流程下线（端点默认返回 410）。迁移旧数据或调试时设环境变量 `WSC3D_LEGACY_AI=1` 可临时恢复。

## 三个进程怎么分工

**前端**（React 19 + Vite + TypeScript）负责所有交互：三维渲染用 Three.js，二维标注画布用 react-konva，知识图谱用 cytoscape。开发时跑在 5173 端口，所有请求走相对路径，由 Vite 的代理把 `/api`、`/assets` 转给后端、`/ai` 转给 AI 服务。

**后端**（Node.js + Express + TypeScript，端口 3100）管的是数据和文件：扫描本地资源目录生成画像石列表（以 `temp/` 里的模型文件为主数据源，每个模型一条记录）、读写 IIML 标注文档（带 ajv 校验）、维护 pic 图片绑定、保存拼接方案、托管三维模型和图片等静态资源、导出训练集。它是唯一直接碰 `data/` 目录的进程。

**AI 服务**（Python + FastAPI，端口 8010）专门做推理和图像处理：SAM3 做文本概念分割（唯一 AI 标注入口），OpenCV 做 mask 合成（补笔/擦除后的清理与矢量化）、线图、高清图转码和质量检查。旧的 MobileSAM / YOLOv8n 端点默认下线（`WSC3D_LEGACY_AI=1` 可临时恢复）。它独立于后端，权重和缓存都放在 `ai-service/` 下面。

三个进程故意拆开，是因为它们的生命周期和技术栈差别很大——AI 模型加载慢、吃内存，单独成进程才不会拖累前端热更新；后端做纯数据读写，保持轻量。以后要换分割模型，或者把 AI 服务搬到另一台带 GPU 的机器，都比较好动。

## 浏览模块

最常见的场景：打开一块画像石，从不同角度看清浮雕细节，量一下尺寸。

- **三种视图**：3D 自由旋转、2D 正面锁定（正交相机，不透视失真）、正射图。视角骰子能一键切到六个标准面。
- **测距**：在模型上点两点量距离。石头档案里记了实际尺寸（高/宽/厚，厘米）时会自动校准——拿模型的长边去对档案里的长边，算出"模型单位 → 厘米"的比例；没有尺寸数据时退回到模型原始单位。注意目前目录扫描不再解析 Markdown 档案，尺寸未补录前显示的是模型单位。
- **光照与背景**：浅浮雕的轮廓高度依赖打光方向，所以背景（黑/灰/白）和光照分档可以独立切换，方便在不同阴影下辨认纹饰。

实现上，三维部分是 Three.js + OrbitControls，模型用 GLTF/GLB 加载；2D 模式把相机锁成正交并固定到正面。测距的比例换算在 [StoneViewer.tsx](frontend/src/modules/viewer/StoneViewer.tsx) 里。

## 拼接方案（工作区已下线）

武氏祠等遗址的画像石很多已经散落，早期版本提供过独立的拼接工作区（多块同场、厘米级微调、方案存档），用于"研究性复原"。UI 收敛时该工作区已从界面移除，但数据链路完整保留：

- 历史方案仍存在 `data/assembly-plans/`，后端 `/api/assembly-plans` 可读写；
- 标注模块导出 `.hpsml` 研究包时，会自动带上与该石头相关的拼接方案，保证研究状态可迁移。

## 标注模块

标注是这个平台的核心。它不是简单地画几个框，而是按图像志（iconography）研究的规矩来组织标注：每条标注既记录几何范围，也记录它的结构层级（整石/场景/人物/构件/刻痕/题刻……）、前图像志描述、图像志含义、图像学解释、受控术语、证据来源等。所有标注最终落成一份 IIML 文档（JSON-LD 风格），存在 `data/iiml/<stoneId>.iiml.json`。

界面布局是"左画布 + 右面板"：左侧是 Konva 标注画布（含竖排工具栏），右侧是 **IIML 四层主面板**，按形相学理论把一块石头的研究组织成四步——**物理层**（材质/技法/断代/出土/保存 + 多源资源管理）→ **视觉层**（构图/线条/空间组织/对称）→ **图像学层**（画面主题、母题区域标注、AI 候选审阅、空间关系、知识图谱）→ **文化层**（宗教意义/社会功能/象征系统/现代阐释）。四层各自显示完成度，结构化数据存进 IIML 文档的 `culturalObject` 下；日常画框标注的工作都发生在图像学层。

下面分几块讲。

### 双底图与多资源切换

画布右上角可以切换 **3D 模型** 和 **高清原图** 两种底图，两种模式下滚轮缩放、中键/右键拖动平移的行为是一致的。

- **3D 模型底图**：标注坐标用模型包围盒的 UV（`(u, v) ∈ [0,1]²`），视图变换交给 OrbitControls。
- **高清原图底图**：从 AI 服务拉 tif 转码后的 PNG（浏览器读不了 tif），标注坐标用图自身的归一化坐标。

高清图模式下还会多出一条资源切换栏，把这块石头 IIML 里登记的所有图像类资源（正射图 / 拓片 / 法线图 / 线图 / RTI / 点云 / 自定义）列成 chip，点一下就换底图。

这里有一个关键设计：**等价正射图**。从三维模型正面、按紧贴包围盒的正交相机生成的正射图，它的 UV 和模型包围盒 UV 是 1:1 相等的——在这种正射图上画的标注，和在 3D 模型视图上画的标注自动共享、双向同步，不需要额外标定。画布顶部会有绿色徽章提示当前是不是等价状态。如果是非等价资源（背面/顶面/拓片/法线图），则走下面要讲的 4 点对齐。

### 工具集

左边工具栏从上到下：

- **选择/移动、矩形、圆/椭圆、点、钢笔**（多边形，双击或回车闭合）——人工几何补正工具。
- **SAM3 概念分割**——唯一 AI 候选生成器，用"人物""马""鸟"这样的概念词驱动。
- **对齐校准（十字准星）**——4 点单应性标定，下面单讲。
- **AI 线图叠加**——5 种边缘检测算法，半透明白线突出浅浮雕轮廓（视觉辅助，不产生标注）。

### SAM3 主标注 + 人工补正

平台的标注工作流收敛为一条主线：**SAM3 生成候选 → 人工审阅 → 手工几何补正**。

- **SAM3 概念分割**：输入中文概念词（人物/马/鸟/兽/车/纹饰）或自定义英文 prompt，前端会自动扩展成英文同义词提交，再按阈值和最大候选数过滤，适配画像石这种非摄影风格的人物轮廓。支持任意资源 URI（正射图、拓片都能直接分割），不限于高清原图。
- **人工补正**：矩形 / 圆 / 点 / 钢笔多边形负责 SAM3 覆盖不到或分割不准的区域。

每次 SAM3 调用都会记一条 `processingRun` 到 IIML 文档，含模型名、参数、置信度、起止时间——这样每条 AI 候选都能追溯到"是哪个模型、什么参数、什么时候产出的"，论文要求的可溯源性自动满足。

候选产出后默认是 `candidate` 状态，在图像学层的"AI 候选审阅"区集中处理：单条接受/拒绝，也能全部接受/拒绝。多条多边形还能勾选后做合并（优先走 AI 服务的 mask 级合成，失败回退矢量并集）。用户审核通过后升到 `reviewed` 或 `approved`，才有资格进训练池。SAM3 与训练导出这类长任务会出现在右下角任务进度面板；SAM3 的多概念词×多阈值尝试可以在组合间取消。

> 历史说明：早期版本同时提供 MobileSAM 交互分割与 YOLOv8n 批量扫描。实际使用中只有 SAM3 的分割质量满足要求，v0.9.0 起两者从界面与主流程移除，AI 服务端点默认 410（`WSC3D_LEGACY_AI=1` 临时恢复）。历史标注文档里 `generation.method = "sam" / "yolo"` 的数据仍正常显示与导出。

### 一标注一图层

每条标注自带颜色、可见性、锁定状态和审核状态。新建后先进"草稿"，详情面板有"确定/取消/删除"。草稿之外的标注也能随时重命名、隐藏、锁定、删除。浏览模式下不渲染标注，避免干扰观看。

### 图像志三层与受控术语

在图像学层选中一条标注，下方展开区域深编辑器（`RegionEditor`），每条标注可以填：

- **结构层级**：whole / scene / figure / component / trace / inscription / damage / unknown。
- **三层文本**：前图像志（preIconographic，纯描述看见了什么）、图像志含义（iconographicMeaning，公认寓意）、图像学解释（iconologicalMeaning，深层阐释）——这是图像志研究的核心框架。
- **领域类别**：14 类汉画像石专用类别（神祇、刺客、孝子、烈女、车马行列、祥瑞、纹饰边框等）。
- **母题 motif**：具体故事或视觉格套，比如"荆轲刺秦王"。
- **受控术语**：从 `data/terms.json` 检索多选，系统还会基于已有标注的术语共现给推荐。
- **证据来源**：分四种——档案（metadata）、文献（reference）、资源（resource）、其它（other）——让每条标注的判断依据可追溯。
- **题刻子面板**：当结构层级是 inscription 时出现，记释文/翻译/释读注。

### 4 点对齐校准

前面提到，等价正射图能和模型 UV 自动同步。但如果用的是拓片、法线图，或者从背面拍的图，坐标系就不等价了，这时需要做一次 4 点标定。

点工具栏的十字准星按钮启动，流程是"乒乓式"采集：先在 3D 模型上点 4 个特征点，自动切到高清图，再点对应的 4 个位置；进入 review 阶段，两套点叠加显示，确认后存进 `culturalObject.alignment`。存好后，模型坐标系下的标注就能投影到高清图上显示（稀疏虚线 + 半透明的"投影态"），反之亦然。没校准的时候，跨 frame 的标注会隐藏并给出提示。

数学核心是 4 点 DLT 求 3×3 单应性矩阵，高斯消元求解 + 矩阵求逆，封装在 [homography.ts](frontend/src/modules/annotation/homography.ts)。保存时还会顺手算一次重投影误差显示在状态条上，让你知道这次标定的质量。

### 关系网络与知识图谱

标注之间还能建立关系，受控 14 种，分四组：叙事（先后/伴随）、层级（包含/属于）、空间（上下左右/相邻/重叠）、解释并存（同一对象的不同释读，比如 A 学者读"青龙"、B 读"独角兽"）。

- **空间关系**可以自动推导——基于几何位置算 above/below/leftOf 等，用户采纳后才入库，不采纳就只是临时显示。
- **知识图谱**（图像学层的"图谱"视图）用 Cytoscape 把标注和关系画出来，支持四种中心性算法（权威度 PageRank、邻居数、桥梁度、接近度）、MCL 群组检测、top-N 高亮。画布上选中一条标注，图谱里对应节点会联动高亮，反过来也一样。

### 训练池导出

标注做到一定量，面板底部的"数据导出 / 导入"条可以导出训练集。`预检` 会先汇总 pic 配对情况、IIML 字段完整度、训练池准入估算和样本不足的类别。`导出训练集` 会把所有石头的 IIML 聚合起来，跑一遍准入校验，按 stoneId 切 70/15/15 的 train/val/test（防止同一块石头的不同部分同时出现在训练集和验证集里造成泄漏），写到 `data/datasets/wsc-han-stone-v0/`：

- `annotations/` 下是 COCO 格式的 train/val/test 三套，外加类别/母题表、弱标注与金标验证清单（weak_annotations / gold_validation）、主动学习队列、基线训练配方（baseline_recipes）和 split 明细；
- `images/` 把每张图按类型（原图/正射/拓片……）和 stoneId 复制过去，pycocotools、YOLO、detectron2 都能直接读；
- `reports/` 是排查训练池的首选文件，逐条列出每条标注有没有进池、被什么原因挡住（bad-category、no-terms、pre-iconographic-too-short、review-status-candidate 等）；
- `iiml/` 是完整的 IIML 备份，保留图像志链路；
- 数据集根目录还有 `stats.json`、`SOURCES.csv`、`DATASET_CHANGELOG.md`，记录类别分布、数据来源和历次导出变更。整个导出先写临时目录再原子替换，不会留下半成品。

导出成功后状态条会出现"目录"按钮，直接打开本机的训练集文件夹。

为了让你在标注时就心里有数，每条标注在区域列表行和编辑区顶部都会显示一个训练就绪度标记——能进池（绿）、能进但有警告（黄）、进不了（红），hover 列出具体卡在哪一项；编辑区还提供"设为已审核""设类别 unknown"这类一键修复。（旧版的列表多选批量修复在四层面板重构中暂未恢复，批量升级候选可先用"全部接受"。）

### 导出

除了训练集，单块石头还支持五种学术导出：IIML / CSV / COCO / IIIF Web Annotation / `.hpsml`（自定义研究包，可以跨机器迁移完整研究状态）。`.hpsml` 也支持一键解包导入。

## 绑定与图片配对（工作台已下线）

高清原图从相机拷出来时是原始文件名，而平台靠"数字前缀 + 可选面位"的命名约定（`29东汉武氏祠….tif`、`03-B….tif`）把图片和画像石对上。早期版本有一个点选式的绑定工作台，UI 收敛时已下线；配对本身仍是平台的基础机制：

- 直接按命名约定改文件名即可被识别；或调后端 `/api/pic/bind` 完成"实际重命名 + 记录映射"（`{编号}{名称}.{扩展名}`，副面追加 `-B` 之类的面位后缀），映射存 `data/pic-bindings.json`，解绑尽量恢复原名，带冲突检测与失败回滚；
- 标注画布的高清底图、双面石的面位切换、SAM3 分割、训练导出复制图片，走的都是同一套前缀匹配；
- `/api/pic/health` 与 `/api/pic/list` 可随时检查配对情况。

## 数据放在哪

启动前确认本机有这些目录（都在仓库父目录，或用环境变量改路径）：

| 目录 | 内容 | 默认路径 | 入库 |
| --- | --- | --- | --- |
| 三维模型 | 64+ 个 .gltf/.glb + 缩略图 | `./temp` | 否 |
| 结构化档案 | 45 份画像石 Markdown 档案 | `./画像石结构化分档` | 否 |
| 参考图 | 标注系统设计参考截图 | `./参考图` | 否 |
| 高清原图 | tif/jpg/png（数字前缀配 stoneId） | `./pic` | 否 |
| AI 转码缓存 | tif→PNG 落盘缓存 | `./ai-service/cache/source/` | 否 |
| 线图缓存 | 各算法×阈值组合的线图 PNG | `./ai-service/cache/lineart/` | 否 |
| SAM 权重 | mobile_sam.pt（首次自动下载） | `./ai-service/weights/` | 否 |
| SAM3 权重 | sam3.pt（gated，手动放或 setup:sam3） | `./ai-service/weights/sam3/` | 否 |
| 术语库 | 人物/动物/器物/场景/纹饰 受控词 | `./data/terms.json` | 是 |
| 标注存储 | 每块石头一份 IIML（另有 `.history/` 自动备份，每石最多 50 份） | `./data/iiml/<stoneId>.iiml.json` | 是 |
| 图片绑定记录 | pic 文件 ↔ 画像石映射 | `./data/pic-bindings.json` | 是 |
| 拼接方案 | JSON 持久化 | `./data/assembly-plans/` | 是 |
| 资源落盘 | 用户生成/上传的正射、拓片等 | `./data/stone-resources/<stoneId>/` | 是 |
| 训练池导出 | COCO train/val/test 等 | `./data/datasets/wsc-han-stone-v0/` | 否 |

可以用 `WSC3D_ROOT`、`WSC3D_MODEL_DIR`、`WSC3D_METADATA_DIR`、`WSC3D_REFERENCE_DIR`、`WSC3D_PIC_DIR`、`WSC3D_IIML_DIR`（迁移脚本用）等环境变量改路径。

## 技术栈选型

- **前端** React 19 + Vite + TypeScript。三维 Three.js，二维标注 react-konva，多边形并集 polygon-clipping，知识图谱 cytoscape。应用壳层是"多 context + 工作区容器"（`src/app/`），浏览与标注两个工作区都走 lazy 加载。
- **后端** Node.js + Express + TypeScript。IIML 文档用 ajv 校验后落盘，拼接方案以 JSON 持久化。
- **AI 服务** Python + FastAPI。Pillow/numpy/OpenCV 做图像处理，SAM3 做概念分割推理（懒加载）。旧 MobileSAM / ultralytics 代码保留但默认下线。
- **数据格式**：标注是类 IIML 的 JSON 文档；两套坐标系（modelBox UV 与高清图自身归一化）用 `frame` 字段区分，靠 `culturalObject.alignment` 里的 4 点单应性矩阵互投。

## API 一览

### 后端 Express :3100

```
GET    /api/health                          健康检查
GET    /api/scan                            扫描汇总
POST   /api/scan/refresh                    强制重建目录缓存
GET    /api/catalog/health                  目录健康度（孤儿模型 / 编号冲突）
GET    /api/stones                          画像石列表
GET    /api/stones/:id/model                画像石模型
GET    /api/stones/:id/metadata             结构化档案（现为空层占位，分层导入走 import-md）
GET    /api/stones/:id/resources            资源列表
POST   /api/stones/:id/resources            上传资源
DELETE /api/stones/:id/resources/:fileName  删除一份正射图
POST   /api/stones/:id/annotations/:annotationId/assets  标注外观资产落盘（mask / 抠图 / 缩略图）
GET    /api/reference-images                参考图列表
GET    /api/terms                           受控术语库
GET    /api/iiml/:stoneId                   读 IIML
PUT    /api/iiml/:stoneId                   存 IIML（ajv 校验 + anchor 派生 + 历史备份）
GET    /api/iiml/alignments                 所有石头的对齐状态
GET    /api/iiml/context                    IIML JSON-LD 上下文
POST   /api/iiml/:stoneId/import-md         从结构化档案导入标注
POST   /api/hpsml/import                    .hpsml 研究包解包导入
GET    /api/pic/health                      pic 目录健康检查与配对情况
GET    /api/pic/list                        pic 文件清单与绑定状态
POST   /api/pic/bind                        绑定图片到画像石（实际重命名文件）
POST   /api/pic/unbind                      解绑并尽量恢复原文件名
GET    /api/preflight                       上线前预检
POST   /api/training/export                 导出 COCO + IIML 双轨训练池
POST   /api/training/reveal-dataset         打开本机训练集目录
GET    /api/assembly-plans                  拼接方案列表
GET    /api/assembly-plans/:id              单条方案
POST   /api/assembly-plans                  保存方案
```

### AI 服务 FastAPI :8010

```
GET    /ai/health                       健康检查 + SAM3 加载状态
POST   /ai/sam3                         SAM3 文本概念分割（唯一 AI 标注入口）
POST   /ai/mask/compose                 mask 合成：几何 + 补笔/擦除 → 形态学清理 → 重新矢量化
GET    /ai/source-image/{stone_id}      高清原图 tif→PNG 转码缓存（支持 face 参数选面位）
GET    /ai/pic-preview                  pic 文件缩略图预览
GET    /ai/quality/{stone_id}           高清图质量指标（分辨率 / 曝光 / 清晰度）
GET    /ai/lineart/{stone_id}           线图 PNG（5 算法×阈值各自缓存）
GET    /ai/lineart/methods              支持的线图方法
POST   /ai/sam                          [legacy] 默认 410；WSC3D_LEGACY_AI=1 恢复
POST   /ai/yolo                         [legacy] 默认 410；WSC3D_LEGACY_AI=1 恢复
POST   /ai/canny                        [legacy] 默认 410；WSC3D_LEGACY_AI=1 恢复
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 前端 + 后端 + AI 三进程并行启动 |
| `npm run dev:backend` / `dev:frontend` / `dev:ai` | 只起其中一个 |
| `npm run build` | 构建前后端产物 |
| `npm run typecheck` | 前后端 TypeScript 类型检查 |
| `npm run test` | 前后端单元测试（纯函数回归网） |
| `npm run scan` | 扫描本地资源、生成缓存 summary |
| `npm run setup:sam3` | 检查 / 导入 / 下载 SAM3 权重 |
| `npm run migrate:iiml-frame` | 给历史 IIML 文档补 `frame="model"`（一次性） |
| `npm run migrate:iiml-anchor` | 给历史 IIML 标注补派生空间锚点 anchor（一次性） |

## 目录结构

```
ai-service/        AI 子服务（Python + FastAPI）
  app/
    main.py            FastAPI 路由入口
    sam3_service.py    SAM3 文本概念分割（唯一 AI 标注入口）
    mask_ops.py        mask 合成与后处理（栅格化 / 形态学清理 / 矢量化）
    sam.py             [legacy] MobileSAM 推理（默认下线）
    yolo.py            [legacy] YOLOv8n + CLAHE 双跑（默认下线）
    canny.py           5 种线图算法 + 落盘缓存
    resources.py       图源匹配 / URI 反解 / 缓存
    quality.py         图像质量指标
    routers/           health / inference / imagery / lineart 路由
  weights/             权重（首次启动自动下载）
  cache/               转码与线图缓存
backend/           Node.js 后端
  src/
    server.ts            Express 入口 + 路由装配
    domain/han-stone.ts  14 类领域枚举（单一事实源）
    services/            catalog / iiml / anchor / homography / pic-bindings /
                         preflight / training-export / training-validation / hpsml …
    routes/              HTTP 边界
    parsers/             结构化档案 Markdown 解析
    scripts/             scan / migrate 一次性脚本
frontend/          React + Three.js + Konva 前端
  src/
    App.tsx                  应用根（AppProviders + AppShell 两行拼装）
    app/                     应用壳层
      AppShell.tsx             顶栏 + 双工作区挂载 + 任务进度面板
      contexts/                全局状态（选石 / 模式 / 视口 / 保存状态 / 任务 / 拼接方案）
      workspaces/              ViewerContainer / AnnotationContainer 容器
      annotation/useAnnotationLogic.tsx  标注用例层（加载 / 自动保存 / SAM3 / 导出）
    api/                     统一 HTTP 封装 + IIML / AI 类型契约（client.ts 单一事实源）
    ui/                      基础组件库（Button / Chip / Field / Tabs…）+ 浮动面板系统
    modules/viewer/          浏览模块
    modules/annotation/      标注模块（约 25 个组件 + 工具）
      AnnotationCanvas.tsx     Konva 画布（跨 frame 渲染、标定 overlay）
      AnnotationWorkspace.tsx  工作区（双底图 + 多资源切换）
      IimlPanel.tsx            IIML 四层主面板（物理 / 视觉 / 图像学 / 文化）
      RegionEditor.tsx         选中区域深编辑（术语 / 证据源 / 训练细节 / 关系）
      iiml-layers.ts           四层数据模型与完成度
      KnowledgeGraphView.tsx   cytoscape 图谱
      homography.ts            4 点单应性矩阵 + 重投影误差
      merge.ts                 候选合并（mask 合成优先，矢量并集回退）
      sam3-prompts.ts          SAM3 概念词扩展与错误文案
      training.ts              训练池准入校验
      exporters.ts             5 种学术导出
    modules/shared/          视角骰子等共享组件
    styles/                  tokens / base / shell / 模块 CSS（styles.css 为遗留样式，逐步迁移）
data/              术语库、IIML 文档、拼接方案、资源落盘、pic 绑定记录
docs/              Release Notes、标注 SOP、最近加固工作日志
```

## 版本与路线

| 版本 | 主题 |
| --- | --- |
| v0.9.0 | 数据可信度加固 · 训练就绪度面板 · 列表批量修复 · AI fallback 分级 · SAM embedding 缓存 · 单元测试底盘 |
| v0.8.0 | 图谱 UI 修缮 · 资源独立 tab · 三维生成正射图 · 多资源画布切换 · 跨资源坐标变换 · `.hpsml` 解包 |
| v0.7.0 | 紧急修复 · 图谱完善 · 多解释 UI · AI 加深 · 多资源 · `.hpsml` 包 |
| v0.6.0 | M3 收尾 · 学术导出 · 工程瘦身 |
| v0.5.0 | 关系网络 · 知识图谱 · 工程闭环 |
| v0.4.0 | AI 加深：SAM 多 prompt · AI 线图 · YOLO 批量候选 |
| v0.3.0 | AI 标注闭环 · 多源底图 · 4 点对齐校准 |
| v0.2.x | 标注「一标注一图层」重构 · 拼接多石修复 |

详细的 release notes 和工作日志在 [docs/](docs/) 下。接下来想做的几件事：

- 画布上的跨资源投影——把标注按资源的变换矩阵直接投影到当前底图坐标系上显示；
- 用现有 COCO 导出积累的标注，微调一个汉画像石专用检测器；
- AI 线图接入 HED / Relic2Contour 这类深度学习方法；
- Playwright 端到端测试，覆盖"标注 → 保存 → 导出"主链路。

## 协议与致谢

- **许可**：本项目采用 **木兰宽松许可证第2版（MulanPSL-2.0）** 授权，详见 [LICENSE](LICENSE)。
- **版权所有（c）2025-2026 Ben Margatroid & 嘉祥县文物保护中心 & 武氏墓群石刻博物馆**。
- **致谢**：项目开发过程中使用了以下开源工具和库：
Three.js
React
Konva / React-Konva
Cytoscape
MobileSAM
SAM3
Ultralytics YOLOv8
OpenCV
FastAPI
Express
polygon-clipping
感谢这些开源项目提供的基础能力。
- **致谢**: Opus 4.6、GPT5.4、GLM5.1等大语言模型，让本平台得以快速迭代。
