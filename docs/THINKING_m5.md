# M5 思考记录与下一阶段规划

> 日期：2026-05-05
> 对应版本：`v0.8.0`
> 关联：[`ROADMAP.md`](ROADMAP.md) · [`RELEASE_NOTES_v0.8.0.md`](RELEASE_NOTES_v0.8.0.md) ·
> [`THINKING_m2.md`](THINKING_m2.md) · `E:\RTI-Learning\papers\reading\06-ai-annotation-line-drawing\` ·
> `E:\RTI-Learning\papers\reading\03-han-stone-reliefs-3d\`

本文是 v0.8.0 完成、即将启动 M5 之前的"科研方向选型"思考记录，回答四件事：

1. v0.8.0 之后真正的阻碍是什么；
2. 殷契文渊（甲骨文 AI 协同平台 [`jgwlbq.org.cn`](https://www.jgwlbq.org.cn/)）作为对标提供的启发；
3. 你圈选的 9 篇论文（24 / 25 / 26 / 34 / 35 / 12 / 31 / 39 / 40）如何落到工程；
4. M5 12 个月四阶段节奏，最终交付 `v1.0` + 公开数据集。

---

## 1. v0.8.0 之后真正的阻碍

工程闭环已经齐了。剩下的"待做"全部指向**同一个根本问题**：领域数据和领域模型不存在。

| 阻碍 | 现状 | 后果 |
| --- | --- | --- |
| 没有汉画像石专用模型 | YOLO 跑通用 COCO，SAM 跑 MobileSAM 通用权重 | 通用模型把"伏羲女娲"识别成 `person + bird`，浅浮雕边缘飘 |
| 没有领域数据集 | 论文 24 数据集不公开，123 + 80 + 82 张也太小 | YOLOv8 / SAM-LoRA 微调没有训练集 |
| 拓片 / RTI / 高度图这条 2.5D 线没打通 | Rubbing / NormalMap / RTI 在 IIML 只有 resource 字段占位，**没有任何算法在用** | RTI-Learning 半年的论文阅读没真正进入 WSC3D |
| 图像学层是单石孤岛 | 知识图谱、共现、关系都局限在单 stoneId 内 | 没法做"全库找出所有伏羲女娲"这种检索 |
| AI 摹本 / 数字拓片缺位 | 论文 25 / 34 的 GAN / 扩散线图 ROADMAP 全在待做 | 殷契文渊最出彩的"AI 摹本"在 WSC3D 完全空白 |

结论：v0.x → v1.x 的关键变化是从**工程基础设施**升级为**领域研究平台**，门票就是数据。

---

## 2. 殷契文渊给的对标坐标

殷契文渊 = 腾讯 SSV + 安阳师范学院甲骨文信息处理教育部重点实验室 + 中国社科院先秦史学会，
2024-05-28 公开开放，2025 年发布"殷契行止"智能体。规模：

- **图像** 24 万 + 张甲骨拓片
- **字形** 143 万字形 / 5086 单字 / 6234 字形变体
- **论著** 3.5 万 + 种
- **公开数据集** 3 个（手写字 / 字检测 / 字识别），下载量 3.4 万 +

核心模块对照 WSC3D：

| 殷契文渊模块 | WSC3D 对应 | 差距 |
| --- | --- | --- |
| 甲骨图像库 24 万 + | `pic/` 几十张 tif | **数据量 4 个数量级** |
| 字形数据 143 万 | `terms.json` 几百词 | 没有"图元数据库" |
| AI 字形检测（`/zodiac` 工具） | YOLO 通用 COCO | **没有领域微调** |
| AI 摹本生成（拓片 → 摹本） | 占位 | 完全空白 |
| 微痕增强 | RTI 占位 | 完全空白 |
| 多层影像对齐 | ✓ 4 点单应性 + 跨资源切换 | 这条做得不差 |
| AI 查重 | 无 | 空白 |
| 协同标注 | `.hpsml` 单包导入导出 | 没有三方合并 |
| 3 个开放数据集 | 无 | 空白 |
| "殷契行止"智能体 | 无 | 远期 |

**关键洞察**：殷契文渊把"领域数据库 + 领域 AI + 协同标注 + 公开数据集 + 论著库"做成了
一个**正反馈循环**——平台越多人用，标注越多，数据集越大，AI 越准，论著越多，吸引更多人用。
WSC3D 工程闭环已在，缺的就是这个**数据正反馈循环**。

---

## 3. 你圈的 9 篇论文 → 工程入口

| # | 论文 | 提供给我们 | 工程入口 |
| --- | --- | --- | --- |
| **24** | 汉画像石增强 YOLOv5（Han Portrait YOLOv5） | 5 类高价值类（伏羲女娲 / 乐舞 / 车马 / 神兽 / 建筑）+ SPD-Conv + Coordinate Attention | 替换默认 YOLOv8 通用权重，加领域微调 |
| **25** | Relic2Contour 半监督 GAN | 拓片病害 / 噪声下的轮廓生成；CGF + AGF + CAT + Bi-GTF | 新算法接入 `/ai/lineart?method=relic2contour` |
| **26** | 点云加权质心线图 | 从 3D 扫描 / 光度立体高度图提几何线 | 新管线 `/ai/lineart-from-pointcloud` |
| **34** | FLUX.1 Kontext + LoRA | 小样本扩散模型生成考古线图 | 远期；先准备训练对（原图 ↔ 人工线图）|
| **35** | ICON Ontology | 图像志三层 + 多解释并存 + 证据资源 | 已落地 ✓（M2 + M3） |
| **12** | 拓片 → 高度图（中文文献） | 把灰度拓片当作浅浮雕高度的近似 + 梯度积分 | 新管线 `/ai/rubbing-to-heightmap` |
| **31** | 武梁祠 3D 数字保护 | 工作流参考：3D / RTI / 图像 / 标注 / 知识图谱串起来 | 验证整体架构方向 ✓ |
| **39** | 多视图 SIFT + 极线几何 | SfM / MVS 路线（COLMAP） | 新管线 `/ai/sfm-reconstruct`，输入 pic/*.tif 多视角 |
| **40** | 明代石碑高精度 3D | 整体几何 + 真实纹理映射 + 精度检查 | 给 `culturalObject` / `resource` 加"精度元数据"字段 |

---

## 4. M5 四条轨道

> 用户拍板：**数据优先**（轨道 A 先）+ **RTI 完整管线**（轨道 B 不缩水）+
> **数据集先内部成熟**（轨道 D 后置）+ **v1.0 release 含公开数据集**（最终目标）。

### 🅰 轨道 A：领域数据集 + 领域微调（论文 24 + 殷契文渊核心）

- **A1 标注 SOP**：定义 5–8 类高价值汉画像石类（伏羲女娲 / 乐舞百戏 / 车马出行 / 神兽 / 建筑 /
  题刻 / 植物边饰 / 仪仗），写入 `docs/han-stone-annotation-SOP.md`
- **A2 主动学习闭环**：YOLO 候选 → SAM 精修 → 人工审核 → IIML `reviewStatus = approved` 进入"训练池"；
  `AnnotationPanel` 加"导出训练集"按钮，按 stoneId / 类别 / reviewStatus 过滤
- **A3 `wsc-han-stone-v0` 内部数据集**：COCO + IIML 双轨格式，落盘到 `data/datasets/wsc-han-stone-v0/`，
  目录结构 `images/{stoneId}/...png` + `annotations/coco_train.json` + `iiml/{stoneId}.iiml.json`
- **A4 YOLOv8/YOLO11 微调**：在 A3 之上跑微调，`ai-service/weights/yolo-han-v1.pt`；
  AI 服务支持 `/ai/yolo?model=generic|han-v1` 模型切换
- **A5 SAM-LoRA 微调**（要 GPU，可选 Q4）：让 SAM mask 边缘对石材纹理更稳

### 🅱 轨道 B：RTI / 拓片 / 高度图完整管线（论文 12 + 25 + 26 + RTI-Learning 血脉）

- **B1 拓片 → 高度图**（论文 12 复现）：`/ai/rubbing-to-heightmap?stoneId=...&resourceId=...`，
  输出新 resource type `HeightMap`；算法走 灰度 → 梯度场 → Frankot–Chellappa Poisson 积分
- **B2 高度图 → 法线图 → WebGL 重打光**：高度图梯度 + 光度立体公式 → `NormalMap` 资源；
  前端 `SourceImageView` 多资源切换里加"光照交互"模式（鼠标位置 = 光源方向）
- **B3 RTI 文件 viewer**：直接吃 `.ptm` / `.rti` / `.hsh` 系数文件，前端 WebGL shader 重打光，
  这是 RTI-Learning 该交付但还没在 WSC3D 出现的核心
- **B4 AI 摹本（数字拓片）**：照片 + 法线图 → 二值线图。第一阶段 HED + 形态学骨架 + 半监督 refine；
  第二阶段上论文 25 的 Relic2Contour-style GAN（CGF + AGF）；输出 resource type `LineDrawing` 候选
- **B5 微痕增强**：specular enhancement / Unsharp Normal / curvature 三种通道，
  作为 IIML 新 resource type `MicroTraceEnhanced`，对照殷契文渊的"微痕增强"
- **B6 RTI 采集 SOP**：`docs/rti-capture-SOP.md`，对照论文 31 武梁祠工作流写采集规范

### 🅲 轨道 C：跨石头知识库 + 图像学检索（殷契文渊"图像 + 字形 + 论著"对标）

- **C1 跨石头知识图谱**：现在 Cytoscape 只看单 stoneId，扩成 `data/iiml/*.iiml.json` 全库联合图，
  `KnowledgeGraphView` 加"全库 / 单石"开关
- **C2 CLIP / DINOv2 图像志检索**：给一张图（或一条 IIML annotation 的 polygon crop）→ 跑 embedding →
  全库相似度排序 → 作为"图像志候选释读"推荐
- **C3 文献库**：仿殷契文渊"3.5 万种论著"，新建 `data/literature/`（题录 JSON + DOI + 关联 stoneId / 主题），
  IIML `evidence.reference` 直接挂这里
- **C4 受控词汇本土化**：terms.json 升级为 *汉画像石专用* 词表，scheme 字段映射 Iconclass / Wikidata / Getty AAT
- **C5 AI 查重**：同主题母题在不同石头上的复刻自动聚类（C2 embedding + 几何相似度）

### 🅳 轨道 D：协同治理与开放数据集（v1.0 收口）

- **D1 `.hpsml` 三方合并 UI**（ROADMAP §3.3 已挂）
- **D2 多用户 provenance**：登录态 + IIML `provenance.author` 完整化
- **D3 标注质量评估**：双标员一致性 (Cohen's κ)，标注审定流程
- **D4 v1.0 公开数据集 release**：内部 v0 → v1 成熟到 200 块石头 / 5000 + 实例后，
  按 CC-BY-NC 释出 `wsc-han-stone-v1` COCO + IIML 双格式（对标殷契文渊三个开放数据集）

---

## 5. 12 个月四阶段节奏

| 阶段 | 时间 | 主轨道 | 阶段产物 |
| --- | --- | --- | --- |
| **Phase 1** | Q1 / 月 1-3 | 🅰 数据建设 + 主动学习 | `v0.9.0` — 数据集 v0（50 块石头 / 1000 实例）+ YOLOv8 han-v0 微调权重 |
| **Phase 2** | Q2 / 月 4-6 | 🅱 RTI 完整管线 | `v0.10.0` — 拓片 → 高度图 → 法线 → 重打光全链；RTI .ptm/.rti viewer；AI 摹本第一版 |
| **Phase 3** | Q3 / 月 7-9 | 🅲 跨石头知识库 | `v0.11.0` — 跨石头图谱 + CLIP 检索 + 文献库 + 词表本土化 |
| **Phase 4** | Q4 / 月 10-12 | 🅳 协同治理 + v1.0 收口 | `v1.0.0` — 数据集扩到 200 / 5000+ → 公开 release |

### Phase 1（Q1，月 1-3）细化

- 月 1：A1 SOP 文档化 + A2 主动学习导出 UI
- 月 2：B1 拓片 → 高度图原型（提前埋种子，Q2 进 mainline）
- 月 3：A3 数据集 v0（50 stones / 1000 instances）+ A4 YOLOv8s 微调 baseline benchmark
- 里程碑：发 `v0.9.0`，README 加"数据集"章节，标注 SOP 公开（CC-BY 文档，数据本身仍内部）

### Phase 2（Q2，月 4-6）细化

- 月 4：B1 拓片 → 高度图 进 mainline + B2 法线图 + WebGL 重打光
- 月 5：B3 RTI 文件 viewer（.ptm / .rti / .hsh 三格式 shader）
- 月 6：B4 AI 摹本第一版（HED + GAN refine）+ B5 微痕增强通道
- 里程碑：发 `v0.10.0`，对照论文 12 / 25 / 26 / 31 各写一份 internal benchmark 报告

### Phase 3（Q3，月 7-9）细化

- 月 7：C1 跨石头知识图谱 + C4 词表本土化映射
- 月 8：C2 CLIP / DINOv2 embedding 检索
- 月 9：C3 文献库 + C5 AI 查重原型
- 里程碑：发 `v0.11.0`，跨库检索 demo 视频

### Phase 4（Q4，月 10-12）细化

- 月 10：D1 .hpsml 三方合并 + D2 多用户 provenance
- 月 11：A5 SAM-LoRA 微调（GPU 资源到位的话）+ 数据集扩到 200 / 5000+
- 月 12：D3 Cohen's κ 双标员评估 + D4 数据集 release 准备（授权 / 文档 / Croissant 元数据 / Hugging Face / Zenodo）
- 里程碑：**`v1.0.0` release + `wsc-han-stone-v1` 公开数据集**

---

## 6. 数据集治理：CC-BY-NC + 来源标注

虽然 v0 阶段先内部，但要从 Day 1 就按"将来要公开"的标准做记录，避免到 v1 时返工：

- **每张图来源**：`data/datasets/wsc-han-stone-v0/SOURCES.csv` 记录每个 stoneId 的：
  - 原文物归属（博物馆 / 馆藏号）
  - 摄影者 / 拓制者 / 扫描者
  - 引用文献（如《中国画像石全集》第 N 卷 第 M 页）
  - 授权状态（公有领域 / 已获授权 / 待确认）
- **标注作者归属**：IIML `provenance.author` 填实，多研究者署名
- **公开前过滤**：`授权状态 != 已确认` 的 stoneId 不进 `wsc-han-stone-v1` 公开版
- **Croissant 元数据**（公开时必备）：参照 mlcommons / google research 的 ML dataset metadata 标准

---

## 7. 衡量指标

| 阶段 | 指标 | v0.8.0 baseline | v1.0 目标 |
| --- | --- | --- | --- |
| **数据规模** | stoneId 数 / 标注实例数 | < 10 / < 200 | 200 / 5000+ |
| **YOLO 精度** | 5 类 mAP@0.5 | 通用 COCO ~0.10（基本不可用）| han-v1 ≥ 0.55 |
| **SAM 精度** | mask IoU vs 人工 | 通用 ~0.78 | LoRA 微调后 ≥ 0.85 |
| **RTI 通路** | 资源类型数 / 算法数 | 8 占位 / 0 | 8 全可用 / 5+ 算法 |
| **跨石头检索** | 检索正确率 top-5 | 无 | ≥ 0.70 |
| **协作能力** | 用户数 / 标注者一致性 κ | 1 / N/A | 3+ / κ ≥ 0.65 |

---

## 8. 与论文 / 殷契文渊的对照（M5 完成后）

| 来源 | 提示 | M5 对应 | 状态 |
| --- | --- | --- | --- |
| 论文 24 YOLO | 类别先聚焦 5-6 个 + 微调 | A1 + A4 | M5 |
| 论文 25 Relic2Contour | 半监督 GAN 线图 | B4 第二阶段 | M5 Phase 2 |
| 论文 26 点云线图 | 几何线图与图像边缘互补 | B2 + B5 | M5 |
| 论文 34 LoRA 扩散 | 小样本风格化线图 | B4 远期延伸 | v1.x 后 |
| 论文 35 ICON Ontology | 图像志三层 + 证据 | M2 ✓ | 已 ✓ |
| 论文 12 拓片高度图 | 灰度 + 梯度积分 | B1 | M5 Phase 2 |
| 论文 31 武梁祠 3D 保护 | 整体工作流 | 全 M5 验证架构 | ✓ |
| 论文 39 多视图 SIFT | SfM / MVS | B3 衍生 | v1.x 后 |
| 论文 40 高精度 3D | 精度元数据 | resource.precision 字段 | M5 Phase 1 |
| 殷契文渊 图像库 | 24 万 + 规模 | A3 + D4 | 数量级仍差 |
| 殷契文渊 字形 / 字检测 | 微调专用模型 | A4 | M5 Phase 1 |
| 殷契文渊 AI 摹本 | 拓片 → 清晰摹本 | B4 | M5 Phase 2 |
| 殷契文渊 微痕增强 | RTI 类增强 | B5 | M5 Phase 2 |
| 殷契文渊 协同标注 | 多人协作 | D1 + D2 | M5 Phase 4 |
| 殷契文渊 3 个开放数据集 | 公开下载 | D4 | M5 Phase 4 |
