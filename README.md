# 武氏墓群石刻数字档案与图像研究平台

> WSC Unified 2.0 · 汉代画像石数字档案、公开展示与研究工作台一体化平台

## 概述

本平台围绕武氏墓群石刻（汉代画像石），把文物档案、照片、拓片、三维模型、图像标注、文献出处与知识图谱整合进同一套数据体系，同时服务两类用户：

- **公众与观众**：博物馆式的公开展示，包括文物档案、院落全景、画像与故事形象库、知识图谱、文献问答和现场电子文创。
- **研究人员**：本地研究工作台，提供图像对齐、AI 分割、结构标注、文献举证、OCR 校订与三维复原。

核心设计原则：

| 原则 | 说明 |
| --- | --- |
| 统一身份 | 以 `武011` 等稳定文物编号关联全部资料，公开展示与研究工作台使用同一份数据 |
| 证据可回溯 | 每个标注、切图和问答结论都记录底图、几何、文献原文位置与审核状态，可回查原石与原书页 |
| 本地优先 | 便携运行环境、本地模型与本地数据库，浏览和人工研究可完全离线；在线问答、生图、视频为可选服务 |
| 原件不失真 | 原图以 ZIP64 无损收纳，按 SHA-256 校验；切图按原像素帧与无损掩膜实时生成，不经缩放转码 |

## 功能模块

### 公开展示

无需登录，首页默认进入。

| 模块 | 路由 | 内容 |
| --- | --- | --- |
| 文物档案 | `#section=archive` | 身份卡、照片、拓片、三维模型、已审图像解读与文献出处 |
| 院落全景 | `#section=scene` | 院落与展厅三维漫游、文物定位、周边环境叠加 |
| 传承中心 | `#section=center` | 汉文化保护传承中心建筑模型：分层、揭顶、爆炸视图，叠加结构、机电、景观与展陈 |
| 画像形象 | `#section=motifs` | 人物、动物、器物、文字的独立切图，可下载原尺寸透明 PNG 与出处 JSON |
| 故事形象 | `#section=stories` | 整幅故事场景与形象组合，与单体形象库双向跳转 |
| 知识图谱 | `#section=graph` | 故事、人物、物象关系，回查原书页与关联标注 |
| 问答 | `#section=search` | 基于本地文献检索与重排的问答，附出处 |
| 电子文创 | `#section=creative` | 现场观众端：主题浏览、壁纸/明信片/表情包、展厅集章；支持自助屏（`kiosk=1`）与展示大屏（`screen=1`）模式 |

### 研究工作台

登录后可用，写操作均需工作台会话。

| 模块 | 内容 |
| --- | --- |
| 图像研究 | 测量、多图对齐与投影、SAM 分割、结构标注树、文献举证、档案维护与资源扫描 |
| 三维复原 | 经审核的复原方案包浏览，与馆藏原件、展厅布局分开管理 |
| 文献中心 | 核心与扩展文献阅读、多引擎 OCR、文段校订、插图与图像引用 |
| 电子文创 | 主题制作八步流程（立项 → 上架）、动态短片、场馆与现场设置及统计 |
| API 配置 | 在线问答、图像生成（Seedream）、视频生成（MiniMax）服务配置 |

辅助工具：西长廊/后展厅摆放工具、原版三维查看器（端口 8040）、研究交接包导入导出。

## 系统架构

```
 浏览器（公开展示 / 研究工作台 / 自助屏）
        │  HTTP :8030（局域网模式同端口）
        ▼
 FastAPI 平台服务 ───── build/web（前端构建产物）
   ├─ /api 业务接口：档案、标注、文献、图谱、文创、布局、工作台鉴权
   ├─ SQLite：data/stonelab.db（研究库）、data/creative.sqlite3（文创）
   ├─ 资源层：resources/ 散文件 + runtime/resource-packs 无损资源包（按逻辑路径透明访问）
   ├─ 本地模型：SAM3 / MobileSAM 分割 · RapidOCR / NDL / MinerU 识别 · BGE 检索重排 · Ollama 问答
   └─ 可选在线服务：问答模型 · Seedream 生图 · MiniMax 视频
```

| 层 | 技术栈 |
| --- | --- |
| 前端 | React 19、TypeScript 5.7、Vite 6、Three.js 0.172、Zustand 5 |
| 后端 | Python 3.12、FastAPI 0.135、Uvicorn、SQLAlchemy 2.0、Pydantic 2 |
| 数据 | SQLite、派生检索索引（`data/index`）、ZIP64 资源包 + SHA-256 清单 |
| AI 模型 | SAM3 / SAM3.1 / MobileSAM、RapidOCR / NDL / MinerU、BGE-M3 / BGE Reranker、Ollama；路由登记于 `config/models.json` |
| 运行环境 | Windows x64 便携包（`runtime/runtime.zip`、`runtime/development.zip`），首次启动解压到 `%LOCALAPPDATA%\WSC-Unified` |
| 制作管线 | Blender、LibreDWG / ezdxf（仅修改三维与测绘制作工程时需要） |

## 快速开始

### 环境要求

- Windows 10/11 64 位，本地可写 NTFS 磁盘（项目含超过 4 GiB 的单文件）。
- 完整项目副本，约 100 GB，另为本机环境缓存预留空间。
- 无需安装系统 Python 或 Node.js，运行包自带。AI 推理可用显卡加速，实际可用的模型取决于本机显卡与驱动。

> **仅克隆本仓库无法直接运行。** 仓库只包含源码、测试、配置与运行包校验清单。原始资料与运行依赖需从完整项目副本补齐：`resources/`、`data/`、`models/`、`runtime/resource-packs/`，以及与校验清单匹配的 `runtime/runtime.zip`、`runtime/development.zip`。补齐后运行 `tools/构建前端.bat` 生成 `build/web`。

### 启动与停止

| 操作 | 入口 | 地址 |
| --- | --- | --- |
| 本机启动 | `启动平台.bat` | <http://127.0.0.1:8030/> |
| 局域网启动 | `启动平台（局域网）.bat` | `http://<主机 IPv4>:8030/` |
| 停止平台及模型服务 | `tools/停止平台.bat` | — |
| 前端开发模式 | `tools/前端开发模式.bat` | <http://127.0.0.1:5175/> |
| 重新构建前端 | `tools/构建前端.bat` | — |

首次启动会校验运行包并准备本机环境，耗时较长；之后复用缓存。默认端口登记在 `config/project.json`。

### 工作台登录

点击右上角登录入口，账号为 `admin`，密码由环境变量 `WSC_WORKSPACE_PASSWORD` 指定。未设置时使用内置默认密码，仅适合本机试用；**局域网部署前务必设置该变量**，并让启动、停止和命令行工具使用同一设置。平台重启后会话失效；同一设备连续输错 5 次需等待 60 秒。

## 项目结构

```
wsc-unified/
├─ 启动平台.bat / 启动平台（局域网）.bat   # 启动入口
├─ src/
│  ├─ backend/app/        # FastAPI：routers/ 接口、services/ 业务、models.py 数据模型
│  ├─ frontend/           # React + Vite：src/pages、src/archive/three（三维）、src/theme.css（主题变量）
│  └─ engines/            # 第三方引擎组件（NDL OCR、pdf.js）
├─ config/                # 项目设置、文物身份目录、资源别名、模型路由、环境锁定文件
├─ tools/                 # 启停、构建、开发模式、交接、数据维护与清理
│  ├─ authoring/          # 三维、贴图与测绘制作脚本（配方见 config/authoring-recipes.json）
│  └─ research/           # 多版本对齐与提取研究管线（离线）
├─ tests/                 # 单元、集成、前端与模型回归测试
├─ docs/                  # 专题文档
├─ data/                  # 研究数据库、OCR 成果、布局、索引、报告与备份     ┐
├─ resources/             # 文物原件（stones/）、文献、场景、文创素材、制作工程  │ 不纳入
├─ models/                # 本地模型权重                                     │ Git，随完整
├─ runtime/               # 运行包、开发包与原图资源包（resource-packs/）       │ 项目保存
└─ build/web/             # 前端构建产物                                     ┘
```

关键约定：

- 文物素材按 `resources/stones/<名称>__<编号>/` 组织，`images/`、`models/`、`metadata/`、`notes/`、`versions/` 分别存放影像、模型、元数据、研究记录与固定底图版本。业务关联只依赖稳定编号。
- 资源的逻辑路径可通过 `config/resource-aliases.json` 映射到实体文件；移动或改名已登记的资料时须同步维护映射与数据库登记。
- `config/creative.json`、`config/rag_config.json`、`.env` 等本机密钥配置不纳入版本管理，换机后在工作台重新填写。

## 开发指南

### 前端

日常开发运行 `tools/前端开发模式.bat`。它在 5175 端口启动 Vite 开发服务器，支持热更新，并把 `/api`、`/files`、`/models`、`/textures`、`/data` 转发到 8030 端口的平台（平台未运行时自动启动）。关闭窗口只停止开发服务器。

8030 端口始终提供 `build/web`。改动定稿后运行 `tools/构建前端.bat`，构建同时做 TypeScript 类型检查。开发模式会在 `src/frontend/node_modules` 建立指向本机缓存的目录联接，该联接已被 Git 忽略。

样式统一使用 `src/frontend/src/theme.css` 中的语义变量（`--bg-*`、`--text-*`、`--accent`、`--line` 等），以支持“墨石”深色与“宣纸”浅色两套主题，不要写死颜色。

### 后端与测试

修改后端代码后需停止并重新启动平台。开发与测试命令在项目根目录执行，通过 `tools/run.ps1` 使用与运行包一致的环境：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tests/test_annotation_geometry.py
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run.ps1 tests/test_geometry_rendering.mjs
```

写入类测试使用临时数据库或临时布局文件，不会改动正式研究库。部分测试依赖 Blender、运行中的平台或模型运行环境，在缺少这些条件时会报错或跳过，属预期行为。

### 数据与存储约定

- **研究库优先经平台 API 修改。** 直接改库的维护工具（如 `tools/cleanup_duplicate_structure.py`）默认只输出计划；加 `--apply` 前须停止平台，执行时会先备份到 `data/backups/`。
- **原图无损收纳。** `tools/compact_resources.py` 把 TIFF 原图按文物收纳进 `runtime/resource-packs`（逐个校验后才移除散文件），`--restore` 可完整还原。资源包与 `versions/` 底图快照是必须保留的资料，不能当作缓存删除。
- **存储清理分档执行。** `tools/storage_cleanup.py` 的每一档都根据当前磁盘状态重新规划，并在 `data/reports/storage-cleanup-20261004/` 记录清单与日志。归档类操作先校验再移除原文件，并提供对应的还原命令。涉及 `resources/` 的档位须先停止平台。执行前先运行 `python tools/storage_cleanup.py status`，并阅读 [`tools/storage_cleanup.md`](tools/storage_cleanup.md)。
- **知识图谱候选** 保存在 `config/knowledge-graph/`，附原文摘录与来源身份；可用 `tools/validate_knowledge_candidates.py` 做只读校验。

### 制作管线

三维场景、贴图与测绘制作脚本位于 `tools/authoring`，仅在修改相应制作工程时需要 Blender 等工具，浏览平台不依赖它们。传承中心模型的重建流程见 [`docs/heritage-center-build.md`](docs/heritage-center-build.md)。

## 部署与运维

| 场景 | 做法 |
| --- | --- |
| 局域网 / 场馆部署 | 用局域网入口启动并设置 `WSC_WORKSPACE_PASSWORD`；首次启用需确认 Windows 防火墙。自助屏与大屏启动脚本可在“电子文创 → 场馆与现场”下载 |
| 迁移到新电脑 | 停止平台后复制整个项目目录（含 `resources`、`models`、`runtime`、`build`、`data`），在新机双击启动；本机缓存无需复制 |
| 离线副本交接研究成果 | `tools/导出研究交接包.bat` → `tools/导入研究交接包.bat`，按生成顺序接力导入；导入前自动备份到 `data/backups/handover-*` |
| 备份 | 交接包不能代替完整备份；复制完整项目前应先正常停止平台 |
| 日志 | `logs/platform.log`（平台）、`logs/segmentation.log`（分割） |

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动后页面未打开 | 首次准备环境较慢；失败时查看启动窗口与 `logs/platform.log` |
| 提示“平台或交接工具正在使用本目录” | 运行 `tools/停止平台.bat` 后重试；仍未退出时按提示的进程号结束进程 |
| 修改前端后仍是旧页面 | 运行 `tools/构建前端.bat` 后按 Ctrl+F5；开发期间改用前端开发模式 |
| 保存文段或布局时提示冲突 | 保留当前调整，读取最新版本后重新核对提交 |
| 局域网设备无法访问 | 核对主机 IPv4、是否以局域网模式启动及防火墙设置 |
| 换机后模型或在线服务不可用 | 核对模型与运行包完整性、显卡驱动，并重新填写在线服务密钥 |
