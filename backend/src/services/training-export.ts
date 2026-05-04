/**
 * A2 训练池导出（M5 Phase 1）
 *
 * 把 `data/iiml/*.iiml.json` 跨 stoneId 聚合 → 跑 SOP §11
 * `validateAnnotationForTraining` 过滤 → 写 SOP §14 完整目录结构到
 * `data/datasets/wsc-han-stone-v0/`。
 *
 * 文件契约严格按 SOP §14 实现，每个文件都是 git diff 友好的 JSON / CSV：
 * - `coco_train.json` / `coco_val.json` / `coco_test.json`：按 stoneId 70/15/15 划分
 *   防止"同一画像石的不同部分"在 train + val 同时出现导致泄漏
 * - `coco_categories.json`：13 类 + unknown 完整定义
 * - `motifs.json`：本次导出涉及的 motif 频次表
 * - `stats.json`：完整统计（类别 / motif / resource 类型 / stone 分布）
 * - `SOURCES.csv`：每张图来源 / 摄影者 / 拓制者 / 授权状态
 * - `iiml/{stoneId}.iiml.json`：完整 IIML 备份（保留 IIML 链路）
 * - `relations/relations_all.jsonl`：图谱训练用关系全集
 * - `reports/export_{ts}.csv`：每条 annotation 是否进训练池 + 原因
 * - `reports/quality_warnings.csv`：质量警告
 *
 * v0.8.x 起的关键约束（A1-A5 对齐 SOP v0.3）：
 * - **图像随导出一起复制**：每个 bucket 的源文件复制到
 *   `images/{type}/{stoneId}/{originalFileName}`，COCO `file_name` 与之一致。
 *   pycocotools / yolo / detectron2 都能直接读。
 * - **真实长宽**：image-size 解析 OriginalImage / Rubbing / NormalMap 的 header；
 *   正射图用 resource.transform.pixelSize；都拿不到才 fallback 1500×1500（产生
 *   `low-resolution` quality warning）
 * - **frame=model 必须 4 点对齐**：未对齐的 model 标注由 training-validation
 *   报 `frame-model-no-alignment` 直接 reject，避免坐标系混淆
 * - **image_id 按 (stoneId, resourceId) 联合分配**：同石头多图（原图 / 正射 /
 *   拓片）拥有独立 image_id，符合 SOP §14 拓片单独切分要求
 * - **质量门槛仅记录不阻断**：长边 < 1500 / 缺图像文件等，写入
 *   `reports/quality_warnings.csv`；未来 CLI 工具可按此二次过滤
 *
 * 设计要点：
 * - 输出目录在每次导出前**完全清空**重写（`data/datasets/wsc-han-stone-v0/`），
 *   防止上次失败的中间产物污染。导出失败时保持原状（先写到 .tmp，成功后 rename）。
 * - 写盘是顺序的，单次导出不会并发文件冲突。
 * - 大数据集（> 10000 annotation）也只占 < 50 MB JSON，不分片。
 */

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import type { IimlAnnotation, IimlDocument, IimlGeometry } from "./iiml.js";
import {
  getAlignmentFromDoc,
  isEquivalentOrthophotoResource,
  validateAnnotationForTraining
} from "./training-validation.js";
import { type AlignmentMatrices, applyHomography, buildAlignmentMatrices } from "./homography.js";
import { findPicForStone, getPicDir } from "./pic.js";

// COCO 类别表（SOP §14.1）—— id 与名称固定，未来不允许重排序
const COCO_CATEGORIES = [
  { id: 1, name: "figure-deity", supercategory: "mythic" },
  { id: 2, name: "figure-immortal", supercategory: "mythic" },
  { id: 3, name: "figure-mythic-ruler", supercategory: "historic" },
  { id: 4, name: "figure-loyal-assassin", supercategory: "historic" },
  { id: 5, name: "figure-filial-son", supercategory: "historic" },
  { id: 6, name: "figure-virtuous-woman", supercategory: "historic" },
  { id: 7, name: "figure-music-dance", supercategory: "daily-life" },
  { id: 8, name: "chariot-procession", supercategory: "daily-life" },
  { id: 9, name: "mythic-creature", supercategory: "mythic" },
  { id: 10, name: "celestial", supercategory: "mythic" },
  { id: 11, name: "daily-life-scene", supercategory: "daily-life" },
  { id: 12, name: "architecture", supercategory: "daily-life" },
  { id: 13, name: "inscription", supercategory: "meta" },
  { id: 14, name: "pattern-border", supercategory: "meta" }
] as const;

// 用 Map<string, number> 而非 readonly tuple 推断的窄类型，让 .get() 接受任意
// 字符串（含 "unknown"）。"unknown" 不在 COCO categories 内，.get 自然返回 undefined，
// 调用点会跳过这条 annotation。
const COCO_CATEGORY_ID_BY_NAME: Map<string, number> = new Map(
  COCO_CATEGORIES.map((c) => [c.name as string, c.id])
);

const DATASET_NAME = "wsc-han-stone-v0";

export type TrainingExportSummary = {
  exportedAt: string;
  datasetDir: string;
  totalAnnotations: number;
  acceptedAnnotations: number;
  skippedAnnotations: number;
  totalStones: number;
  acceptedStones: number;
  splits: { train: number; val: number; test: number };
  categoryDistribution: Record<string, number>;
  motifDistribution: Record<string, number>;
  warningCounts: Record<string, number>;
  /** 报告文件名（reports/export_{ts}.csv） */
  reportFileName: string;
};

type StoneDocPair = {
  stoneId: string;
  doc: IimlDocument;
};

type AcceptedAnn = {
  stoneId: string;
  // 该 ann 关联的 image bucket（同一 bucket 共享 imageId / 真实图像 / 长宽 /
  // file_name 等）。SOP §14：拓片 / 法线 / 原图等不同坐标系必须有独立 image_id。
  bucket: ImageBucket;
  ann: IimlAnnotation;
  // 反投影后落在 image frame 的几何（与 ann.target 可能不同）。
  // SOP §3.4：训练池只接受 frame=image 几何；frame=model 的 ann 经 4 点单应性
  // 投到 image 后得到此 effectiveTarget。convertToCocoAnn 写盘时用此字段，
  // 不再用 ann.target，避免坐标系混淆。
  effectiveTarget: IimlGeometry;
};

/**
 * 图像桶：一个 (stoneId, resourceId) 对一个 image_id。SOP §14 写明
 * `images/original/`、`images/orthophoto/`、`images/rubbing/` 等子目录独立切分，
 * 因为它们坐标系互不等价（拓片黑白二值、法线图通道不同、正射图分辨率不同）。
 */
type ImageType = "original" | "orthophoto" | "rubbing" | "normal" | "lineart" | "rti" | "trace" | "other";

type ImageBucket = {
  imageId: number;
  stoneId: string;
  resourceId: string;
  imageType: ImageType;
  // 真实长宽：image-size 读 OriginalImage、resource.transform.pixelSize 读正射图
  // 等。失败回落到 (1500, 1500) 但产生 quality_warning。
  width: number;
  height: number;
  // 磁盘原始路径：A3 复制 / 硬链时使用。undefined 表示该资源没有可访问的本地文件
  // （如 base64 嵌入的资源）；此时 file_name 仍能写，但 images/ 下文件留空，
  // reports/quality_warnings.csv 会有一条 missing-image-file。
  sourcePath?: string;
  // COCO file_name：相对 dataset 根的路径，如 `original/01/29东汉武氏祠.tif`
  cocoFileName: string;
};

// IIML resource.type → SOP §14 图像子目录
const RESOURCE_TYPE_TO_IMAGE_TYPE: Record<string, ImageType> = {
  OriginalImage: "original",
  Orthophoto: "orthophoto",
  Rubbing: "rubbing",
  NormalMap: "normal",
  LineDrawing: "lineart",
  RTI: "rti",
  MicroTraceEnhanced: "trace"
};

type SkippedAnn = {
  stoneId: string;
  ann: IimlAnnotation;
  errors: string[];
};

/**
 * 主入口：扫所有 IIML → 校验 → 写盘。返回汇总。
 *
 * @param projectRoot - 项目根目录（与 iiml.ts 一致用法）
 */
export async function exportTrainingDataset(projectRoot: string): Promise<TrainingExportSummary> {
  const exportedAt = new Date().toISOString();
  const datasetRoot = path.join(projectRoot, "data", "datasets", DATASET_NAME);
  const tmpRoot = `${datasetRoot}.tmp`;

  // 1. 清空 tmp（如有上次失败残留）
  await rm(tmpRoot, { recursive: true, force: true });
  await mkdir(tmpRoot, { recursive: true });

  // 2. 扫所有 IIML
  const stones = await loadAllIimlDocs(projectRoot);

  // 3. 跨 stone 聚合 + 校验 + 图像桶解析（每个 (stoneId, resource) 一个 image_id）
  const { accepted, skipped, warningCounts, buckets, qualityWarnings } =
    await aggregateAndValidate(stones, projectRoot);

  // 4. 按 stoneId 70/15/15 分 splits（防止同石头跨 split 泄漏）
  const splits = await splitByStone(projectRoot, stones, accepted);

  // 5. 写 SOP §14 完整目录结构
  const reportFileName = await writeAllOutputs({
    tmpRoot,
    exportedAt,
    stones,
    accepted,
    skipped,
    warningCounts,
    splits,
    buckets,
    qualityWarnings
  });

  // 6'. 复制图像文件：每个 bucket 把 sourcePath → tmpRoot/images/{type}/{stoneId}/...
  await copyBucketImages(tmpRoot, buckets);

  // 6. tmp → 正式目录（rename atomic）
  await rm(datasetRoot, { recursive: true, force: true });
  await mkdir(path.dirname(datasetRoot), { recursive: true });
  // Windows 下 fs.promises.rename 不支持目录重命名跨设备；这里同盘直接 rename
  await renameDir(tmpRoot, datasetRoot);

  // 7. 汇总
  return {
    exportedAt,
    datasetDir: path.relative(projectRoot, datasetRoot).replace(/\\/g, "/"),
    totalAnnotations: accepted.length + skipped.length,
    acceptedAnnotations: accepted.length,
    skippedAnnotations: skipped.length,
    totalStones: stones.length,
    acceptedStones: new Set(accepted.map((a) => a.stoneId)).size,
    splits: { train: splits.train.length, val: splits.val.length, test: splits.test.length },
    categoryDistribution: countCategoryDistribution(accepted),
    motifDistribution: countMotifDistribution(accepted),
    warningCounts,
    reportFileName
  };
}

async function loadAllIimlDocs(projectRoot: string): Promise<StoneDocPair[]> {
  const dir = path.join(projectRoot, "data", "iiml");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const fileNames = entries.filter((name) => name.endsWith(".iiml.json")).sort();
  const result: StoneDocPair[] = [];
  for (const fileName of fileNames) {
    const stoneId = fileName.replace(/\.iiml\.json$/u, "");
    try {
      const raw = await readFile(path.join(dir, fileName), "utf8");
      const doc = JSON.parse(raw) as IimlDocument;
      // 不跑 validateIimlDoc——我们只对 annotation 单条校验，IIML 文档级 schema
      // 错误（虽然不该有）让 saveIimlDoc 那条路径处理。
      result.push({ stoneId, doc });
    } catch (error) {
      // 单文件解析失败不影响其他石头的导出，记一条 console.warn 提示
      // eslint-disable-next-line no-console
      console.warn(`[training-export] skip ${fileName}: ${(error as Error).message}`);
    }
  }
  return result;
}

async function aggregateAndValidate(
  stones: StoneDocPair[],
  projectRoot: string
): Promise<{
  accepted: AcceptedAnn[];
  skipped: SkippedAnn[];
  warningCounts: Record<string, number>;
  buckets: ImageBucket[];
  qualityWarnings: Array<{ stoneId: string; resourceId: string; reason: string; detail?: string }>;
}> {
  const accepted: AcceptedAnn[] = [];
  const skipped: SkippedAnn[] = [];
  const warningCounts: Record<string, number> = {};
  const qualityWarnings: Array<{ stoneId: string; resourceId: string; reason: string; detail?: string }> = [];
  // bucket key = `${stoneId}::${resourceId}`，跨 ann 共享
  const bucketByKey = new Map<string, ImageBucket>();
  let nextImageId = 1;

  for (const stone of stones) {
    const alignment = getAlignmentFromDoc(stone.doc);
    const matrices = alignment ? buildAlignmentMatrices(alignment) : ({} as AlignmentMatrices);

    for (const ann of stone.doc.annotations) {
      const result = validateAnnotationForTraining(ann, stone.doc);
      if (!result.ready) {
        skipped.push({ stoneId: stone.stoneId, ann, errors: result.errors });
        for (const w of result.warnings) warningCounts[w] = (warningCounts[w] ?? 0) + 1;
        continue;
      }

      // 反投影：frame=model + 非等价正射 → modelToImage 单应性
      const effectiveTarget = projectAnnToImageFrame(ann, stone.doc, matrices);
      if (!effectiveTarget) {
        skipped.push({ stoneId: stone.stoneId, ann, errors: ["frame-model-projection-failed"] });
        continue;
      }

      // 决定 effective resourceId：frame=model 反投影后绑到 OriginalImage（pic 原图）
      const effectiveResourceId = resolveEffectiveResourceId(ann, stone.doc);
      if (!effectiveResourceId) {
        skipped.push({ stoneId: stone.stoneId, ann, errors: ["no-original-image-resource"] });
        continue;
      }

      // 解析 / 缓存 bucket
      const bucketKey = `${stone.stoneId}::${effectiveResourceId}`;
      let bucket = bucketByKey.get(bucketKey);
      if (!bucket) {
        const resolved = await resolveImageBucket(stone, effectiveResourceId, projectRoot);
        if (!resolved) {
          skipped.push({ stoneId: stone.stoneId, ann, errors: ["resource-not-found"] });
          continue;
        }
        bucket = { ...resolved, imageId: nextImageId };
        nextImageId += 1;
        bucketByKey.set(bucketKey, bucket);

        // 图像质量门槛（SOP §3.5）：长边 ≥ 1500
        const longEdge = Math.max(bucket.width, bucket.height);
        if (longEdge < 1500) {
          qualityWarnings.push({
            stoneId: stone.stoneId,
            resourceId: effectiveResourceId,
            reason: "low-resolution",
            detail: `longEdge=${longEdge}px (要求 ≥ 1500)`
          });
        }
        if (!bucket.sourcePath) {
          qualityWarnings.push({
            stoneId: stone.stoneId,
            resourceId: effectiveResourceId,
            reason: "missing-image-file",
            detail: `${bucket.imageType} 资源没有可读的本地文件`
          });
        }
      }

      accepted.push({ stoneId: stone.stoneId, bucket, ann, effectiveTarget });
      for (const w of result.warnings) warningCounts[w] = (warningCounts[w] ?? 0) + 1;
    }
  }

  return {
    accepted,
    skipped,
    warningCounts,
    buckets: Array.from(bucketByKey.values()),
    qualityWarnings
  };
}

/**
 * 决定 ann 在导出时关联的资源：
 *  - frame=image：原 ann.resourceId
 *  - frame=model + 等价正射：原 ann.resourceId（坐标系本就 == image）
 *  - frame=model + 单应性反投影：强制绑到 OriginalImage（pic/ 原图）。
 *    没有 OriginalImage（老 doc 未迁移、pic 缺图）→ 返回 undefined，调用方记
 *    `no-original-image-resource` 错误并跳过这条 ann。
 */
function resolveEffectiveResourceId(ann: IimlAnnotation, doc: IimlDocument): string | undefined {
  const frame = ann.frame ?? "model";
  if (frame === "image") return ann.resourceId;
  if (isEquivalentOrthophotoResource(ann.resourceId, doc)) return ann.resourceId;
  // frame=model + 反投影 → 落到 OriginalImage
  const original = doc.resources.find((r) => (r as Record<string, unknown>).type === "OriginalImage") as
    | Record<string, unknown>
    | undefined;
  return original ? String(original.id) : undefined;
}

/**
 * 把 doc.resources 中的一条解析为 ImageBucket：图像类型、真实长宽、磁盘路径、
 * COCO file_name。优先级：
 *  1. resource.transform.pixelSize（正射图明确写了像素尺寸）
 *  2. image-size 读真实文件 header（OriginalImage / Rubbing / NormalMap 等磁盘文件）
 *  3. resource.{width,height} 字段
 *  4. 兜底 1500×1500（产生 quality warning）
 */
async function resolveImageBucket(
  stone: StoneDocPair,
  resourceId: string,
  projectRoot: string
): Promise<Omit<ImageBucket, "imageId"> | undefined> {
  const raw = stone.doc.resources.find((r) => (r as Record<string, unknown>).id === resourceId) as
    | Record<string, unknown>
    | undefined;
  if (!raw) return undefined;
  const rawType = String(raw.type ?? "Other");
  const imageType: ImageType = RESOURCE_TYPE_TO_IMAGE_TYPE[rawType] ?? "other";

  // 1) 找磁盘路径
  let sourcePath: string | undefined;
  if (rawType === "OriginalImage") {
    const pic = await findPicForStone(getPicDir(projectRoot), stone.stoneId);
    if (pic) sourcePath = pic.path;
  } else if (typeof raw.uri === "string") {
    const localPath = resolveLocalUri(raw.uri as string, projectRoot);
    if (localPath) sourcePath = localPath;
  }

  // 2) 真实长宽
  let width: number | undefined;
  let height: number | undefined;
  const transform = raw.transform as Record<string, unknown> | undefined;
  const pixelSize = transform?.pixelSize as { width?: number; height?: number } | undefined;
  if (pixelSize?.width && pixelSize?.height) {
    width = Number(pixelSize.width);
    height = Number(pixelSize.height);
  }
  if ((!width || !height) && sourcePath) {
    try {
      const buf = await readFile(sourcePath);
      const dims = imageSize(buf);
      if (dims.width && dims.height) {
        width = dims.width;
        height = dims.height;
      }
    } catch {
      // image-size 不支持的格式（部分 tif 变种）或读文件失败 → 走下面 fallback
    }
  }
  if ((!width || !height) && typeof raw.width === "number" && typeof raw.height === "number") {
    width = Number(raw.width);
    height = Number(raw.height);
  }
  if (!width || !height) {
    width = 1500;
    height = 1500;
  }

  // 3) COCO file_name
  const fileName =
    (typeof raw.originalFileName === "string" && raw.originalFileName) ||
    (sourcePath && path.basename(sourcePath)) ||
    `${resourceId.replace(/[/\\:*?"<>|]/g, "_")}.png`;
  const cocoFileName = `${imageType}/${stone.stoneId}/${fileName}`;

  return {
    stoneId: stone.stoneId,
    resourceId,
    imageType,
    width,
    height,
    sourcePath,
    cocoFileName
  };
}

/**
 * 把 IIML resource.uri 解析成本地绝对路径。仅支持：
 *   - `/assets/stone-resources/...` → `<projectRoot>/data/stone-resources/...`
 *   - `file://...`
 *   - 相对路径（视作相对项目根）
 * 其他（HTTP/HTTPS 外链、`/ai/source-image/...`）返回 undefined：
 *   - HTTP 外链：不在导出范围内
 *   - `/ai/source-image/...`：实际由 OriginalImage 路径分支处理（findPicForStone）
 */
function resolveLocalUri(uri: string, projectRoot: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("/assets/stone-resources/")) {
    const rel = uri.slice("/assets/stone-resources/".length);
    return path.join(projectRoot, "data", "stone-resources", rel);
  }
  if (uri.startsWith("file://")) {
    return uri.slice("file://".length);
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) return undefined;
  if (uri.startsWith("/")) return undefined; // 其它 /api 或 /ai 路由
  return path.join(projectRoot, uri);
}

/**
 * 把每个 bucket 的 sourcePath 复制到 dataset 的 images/{type}/{stoneId}/ 目录。
 * 没有 sourcePath 的 bucket（外链 / 不存在的本地文件）只建空目录占位。
 */
async function copyBucketImages(tmpRoot: string, buckets: ImageBucket[]): Promise<void> {
  for (const bucket of buckets) {
    const targetDir = path.join(tmpRoot, "images", bucket.imageType, bucket.stoneId);
    await mkdir(targetDir, { recursive: true });
    if (!bucket.sourcePath) continue;
    const targetPath = path.join(tmpRoot, "images", bucket.cocoFileName);
    try {
      await copyFile(bucket.sourcePath, targetPath);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        `[training-export] copy failed: ${bucket.sourcePath} -> ${targetPath}: ${(error as Error).message}`
      );
    }
  }
}

/**
 * 按 stoneId 划分 70/15/15。
 *
 * 优先级：
 *   1. **人工 override**：`data/datasets/stone_split.override.json` 形如
 *      `{ "train": ["01","02"], "val": ["03"], "test": ["04"] }`。SOP §13 的
 *      P0/P1/P2 优先级映射就靠这个手动落地（如把 P0 全放 train，P2 给 test）。
 *   2. **哈希 fallback**：djb2 把 stoneId 哈希到 [0,1)，[0,0.7)→train、
 *      [0.7,0.85)→val、[0.85,1)→test。同一份输入恒定可重现。
 *
 * override 里没列的 stoneId 仍走哈希分桶，方便混合使用（标员只手挑关键石头）。
 */
async function splitByStone(
  projectRoot: string,
  stones: StoneDocPair[],
  accepted: AcceptedAnn[]
): Promise<{ train: AcceptedAnn[]; val: AcceptedAnn[]; test: AcceptedAnn[] }> {
  const override = await loadStoneSplitOverride(projectRoot);
  const splitMap = new Map<string, "train" | "val" | "test">();
  for (const stone of stones) {
    if (override.train.has(stone.stoneId)) splitMap.set(stone.stoneId, "train");
    else if (override.val.has(stone.stoneId)) splitMap.set(stone.stoneId, "val");
    else if (override.test.has(stone.stoneId)) splitMap.set(stone.stoneId, "test");
    else {
      const h = djb2Hash01(stone.stoneId);
      if (h < 0.7) splitMap.set(stone.stoneId, "train");
      else if (h < 0.85) splitMap.set(stone.stoneId, "val");
      else splitMap.set(stone.stoneId, "test");
    }
  }
  const train: AcceptedAnn[] = [];
  const val: AcceptedAnn[] = [];
  const test: AcceptedAnn[] = [];
  for (const item of accepted) {
    const split = splitMap.get(item.stoneId) ?? "train";
    if (split === "train") train.push(item);
    else if (split === "val") val.push(item);
    else test.push(item);
  }
  return { train, val, test };
}

async function loadStoneSplitOverride(
  projectRoot: string
): Promise<{ train: Set<string>; val: Set<string>; test: Set<string> }> {
  const empty = { train: new Set<string>(), val: new Set<string>(), test: new Set<string>() };
  const candidatePaths = [
    path.join(projectRoot, "data", "datasets", "stone_split.override.json"),
    path.join(projectRoot, "data", "stone_split.override.json")
  ];
  for (const p of candidatePaths) {
    try {
      const raw = await readFile(p, "utf8");
      const parsed = JSON.parse(raw) as { train?: string[]; val?: string[]; test?: string[] };
      return {
        train: new Set(parsed.train ?? []),
        val: new Set(parsed.val ?? []),
        test: new Set(parsed.test ?? [])
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // eslint-disable-next-line no-console
        console.warn(`[training-export] split override parse failed at ${p}: ${(error as Error).message}`);
      }
      // 没找到 / 解析失败都尝试下一个；都没就走哈希
    }
  }
  return empty;
}

/**
 * 把 annotation.target 反投影到 image frame：
 *  - frame === "image"：原样返回
 *  - frame === "model" + 等价正射图资源：原样返回（坐标系本就 == image）
 *  - frame === "model" + 已校准 alignment：经 modelToImage 矩阵逐点变换
 *  - 矩阵不可用 / 投影后任意点 NaN：返回 undefined（aggregateAndValidate 会标记
 *    "frame-model-projection-failed" 并跳过）
 *
 * 注意：调用前 `validateAnnotationForTraining` 已经把"既非等价正射也无 alignment"
 * 的 frame=model 标注直接 reject 掉，所以这里 frame=model 一定有可用变换路径；
 * 防御性地兜一次"项目根能把 alignment 弄丢"的极端情况（矩阵求逆退化）。
 */
function projectAnnToImageFrame(
  ann: IimlAnnotation,
  doc: IimlDocument,
  matrices: AlignmentMatrices
): IimlGeometry | undefined {
  const frame = ann.frame ?? "model";
  if (frame === "image") return ann.target;
  if (isEquivalentOrthophotoResource(ann.resourceId, doc)) return ann.target;
  // frame === "model" + 非等价 → 走 modelToImage
  const H = matrices.modelToImage;
  if (!H) return undefined;
  return projectGeometry(ann.target, ([u, v]) => applyHomography(H, [u, v]));
}

/**
 * 通用几何变换：用 mapper 函数变换每个顶点。Point/LineString/Polygon/MultiPolygon/BBox
 * 全支持，BBox 需要先把 [u1,v1,u2,v2] 当成 4 个角变换再重新求外包矩形（单应性下
 * 矩形不一定保持矩形）。任意点 NaN/Infinity → 返回 undefined。
 */
function projectGeometry(
  geometry: IimlGeometry,
  mapper: (point: readonly [number, number]) => readonly [number, number]
): IimlGeometry | undefined {
  const safe = (point: readonly [number, number]): [number, number] | undefined => {
    const next = mapper(point);
    if (!Number.isFinite(next[0]) || !Number.isFinite(next[1])) return undefined;
    return [next[0], next[1]];
  };

  switch (geometry.type) {
    case "Point": {
      const [x, y] = geometry.coordinates as [number, number];
      const next = safe([x, y]);
      if (!next) return undefined;
      return { type: "Point", coordinates: next };
    }
    case "LineString": {
      const out: [number, number][] = [];
      for (const p of geometry.coordinates) {
        const next = safe([Number(p[0]), Number(p[1])]);
        if (!next) return undefined;
        out.push(next);
      }
      return { type: "LineString", coordinates: out };
    }
    case "Polygon": {
      const rings: [number, number][][] = [];
      for (const ring of geometry.coordinates) {
        const newRing: [number, number][] = [];
        for (const p of ring) {
          const next = safe([Number(p[0]), Number(p[1])]);
          if (!next) return undefined;
          newRing.push(next);
        }
        rings.push(newRing);
      }
      return { type: "Polygon", coordinates: rings };
    }
    case "MultiPolygon": {
      const polys: [number, number][][][] = [];
      for (const poly of geometry.coordinates) {
        const rings: [number, number][][] = [];
        for (const ring of poly) {
          const newRing: [number, number][] = [];
          for (const p of ring) {
            const next = safe([Number(p[0]), Number(p[1])]);
            if (!next) return undefined;
            newRing.push(next);
          }
          rings.push(newRing);
        }
        polys.push(rings);
      }
      return { type: "MultiPolygon", coordinates: polys };
    }
    case "BBox": {
      // 4 角变换后取外包矩形：单应性下矩形不一定保持矩形，外包是次优但无歧义。
      const [u1, v1, u2, v2] = geometry.coordinates;
      const corners = [
        [u1, v1],
        [u2, v1],
        [u2, v2],
        [u1, v2]
      ] as const;
      const projected: [number, number][] = [];
      for (const corner of corners) {
        const next = safe(corner);
        if (!next) return undefined;
        projected.push(next);
      }
      const xs = projected.map((p) => p[0]);
      const ys = projected.map((p) => p[1]);
      return {
        type: "BBox",
        coordinates: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
      };
    }
    default:
      return undefined;
  }
}

function djb2Hash01(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

async function writeAllOutputs(args: {
  tmpRoot: string;
  exportedAt: string;
  stones: StoneDocPair[];
  accepted: AcceptedAnn[];
  skipped: SkippedAnn[];
  warningCounts: Record<string, number>;
  splits: { train: AcceptedAnn[]; val: AcceptedAnn[]; test: AcceptedAnn[] };
  buckets: ImageBucket[];
  qualityWarnings: Array<{ stoneId: string; resourceId: string; reason: string; detail?: string }>;
}): Promise<string> {
  const { tmpRoot, exportedAt, stones, accepted, skipped, warningCounts, splits, buckets, qualityWarnings } = args;

  // 子目录预创建
  await mkdir(path.join(tmpRoot, "annotations", "splits"), { recursive: true });
  await mkdir(path.join(tmpRoot, "iiml"), { recursive: true });
  await mkdir(path.join(tmpRoot, "relations"), { recursive: true });
  await mkdir(path.join(tmpRoot, "reports"), { recursive: true });
  // images/ 子目录：copyBucketImages 会按需创建 {type}/{stoneId}/，先建顶层占位
  await mkdir(path.join(tmpRoot, "images"), { recursive: true });

  const stoneIds = stones.map((s) => s.stoneId);
  const stoneNameMap = new Map(stones.map((s) => [s.stoneId, getDisplayName(s.doc)] as const));

  // README
  await writeFile(path.join(tmpRoot, "README.md"), buildReadme(exportedAt, stones.length, accepted.length), "utf8");

  // SOURCES.csv
  await writeFile(path.join(tmpRoot, "SOURCES.csv"), buildSourcesCsv(stones), "utf8");

  // stats.json
  await writeFile(
    path.join(tmpRoot, "stats.json"),
    JSON.stringify(buildStats(exportedAt, accepted, skipped, splits, stones, warningCounts), null, 2),
    "utf8"
  );

  // annotations/coco_categories.json
  await writeFile(
    path.join(tmpRoot, "annotations", "coco_categories.json"),
    JSON.stringify(COCO_CATEGORIES, null, 2),
    "utf8"
  );

  // annotations/motifs.json
  await writeFile(
    path.join(tmpRoot, "annotations", "motifs.json"),
    JSON.stringify(buildMotifsManifest(accepted), null, 2),
    "utf8"
  );

  // annotations/coco_train|val|test.json
  for (const splitName of ["train", "val", "test"] as const) {
    const slice = splits[splitName];
    const cocoDoc = buildCocoDoc(splitName, slice, stoneNameMap, exportedAt);
    await writeFile(
      path.join(tmpRoot, "annotations", `coco_${splitName}.json`),
      JSON.stringify(cocoDoc, null, 2),
      "utf8"
    );
  }

  // annotations/splits/{type}_split.json — 按图像类型独立切分（SOP §14）
  for (const imageType of ["original", "orthophoto", "rubbing", "normal", "lineart", "rti", "trace"] as const) {
    const typeBuckets = buckets.filter((b) => b.imageType === imageType);
    if (typeBuckets.length === 0) continue;
    const typeAccepted = accepted.filter((a) => a.bucket.imageType === imageType);
    const typeSplits = {
      train: typeAccepted.filter((a) => splits.train.includes(a)),
      val: typeAccepted.filter((a) => splits.val.includes(a)),
      test: typeAccepted.filter((a) => splits.test.includes(a))
    };
    await writeFile(
      path.join(tmpRoot, "annotations", "splits", `${imageType}_split.json`),
      JSON.stringify(buildTypeSplit(imageType, typeBuckets, typeSplits), null, 2),
      "utf8"
    );
  }

  // annotations/splits/{type}_split.json
  await writeFile(
    path.join(tmpRoot, "annotations", "splits", "stone_split.json"),
    JSON.stringify(buildStoneSplit(stoneIds, splits), null, 2),
    "utf8"
  );

  // iiml/{stoneId}.iiml.json — 完整备份
  for (const stone of stones) {
    await writeFile(
      path.join(tmpRoot, "iiml", `${stone.stoneId}.iiml.json`),
      `${JSON.stringify(stone.doc, null, 2)}\n`,
      "utf8"
    );
  }

  // relations/relations_all.jsonl
  await writeFile(
    path.join(tmpRoot, "relations", "relations_all.jsonl"),
    buildRelationsJsonl(stones),
    "utf8"
  );

  // reports/export_{ts}.csv
  const safeTs = exportedAt.replace(/[:.]/g, "-");
  const reportFileName = `export_${safeTs}.csv`;
  await writeFile(
    path.join(tmpRoot, "reports", reportFileName),
    buildReportCsv(accepted, skipped, splits),
    "utf8"
  );

  // reports/quality_warnings.csv
  await writeFile(
    path.join(tmpRoot, "reports", "quality_warnings.csv"),
    buildQualityWarningsCsv(accepted, warningCounts, qualityWarnings),
    "utf8"
  );

  return reportFileName;
}

function getDisplayName(doc: IimlDocument): string {
  return (doc.name ?? doc.documentId ?? "").toString();
}

// =============================================================================
// 各文件构建器
// =============================================================================

type CocoImage = {
  id: number;
  width: number;
  height: number;
  file_name: string;
  // 扩展：反查 IIML 原始资源 + 同 stone 多 image 区分
  stone_id: string;
  display_name: string;
  image_type: ImageType;
  resource_id: string;
};

type CocoAnnotationOut = {
  id: number;
  image_id: number;
  category_id: number;
  bbox: [number, number, number, number];
  area: number;
  iscrowd: 0 | 1;
  segmentation?: number[][];
  // SOP §14.2 IIML 字段保留 → COCO extension
  extension: {
    iiml_id: string;
    iiml_label?: string;
    iiml_motif?: string;
    iiml_structuralLevel?: string;
    iiml_terms: string[];
    iiml_reviewStatus?: string;
    iiml_resource_id?: string;
    iiml_provenance_author?: string;
    iiml_frame?: string;
    // SOP §3.4：true 表示几何已从 model frame 经 4 点单应性反投影到 image frame
    iiml_projected: boolean;
  };
};

type CocoDoc = {
  info: {
    description: string;
    version: string;
    split: string;
    year: number;
    contributor: string;
    date_created: string;
  };
  licenses: Array<{ id: number; name: string; url?: string }>;
  images: CocoImage[];
  annotations: CocoAnnotationOut[];
  categories: typeof COCO_CATEGORIES;
};

function buildCocoDoc(
  splitName: "train" | "val" | "test",
  slice: AcceptedAnn[],
  stoneNameMap: Map<string, string>,
  exportedAt: string
): CocoDoc {
  // 该 split 用到的 buckets（去重）
  const usedBuckets = new Map<number, ImageBucket>();
  for (const item of slice) {
    usedBuckets.set(item.bucket.imageId, item.bucket);
  }
  const images: CocoImage[] = Array.from(usedBuckets.values())
    .sort((a, b) => a.imageId - b.imageId)
    .map((bucket) => ({
      id: bucket.imageId,
      width: bucket.width,
      height: bucket.height,
      // SOP §14：file_name 相对 dataset 根的 images/ 子树；训练框架可
      //   image_root = dataset/images, ann_file = dataset/annotations/coco_*.json
      file_name: bucket.cocoFileName,
      stone_id: bucket.stoneId,
      display_name: stoneNameMap.get(bucket.stoneId) ?? bucket.stoneId,
      image_type: bucket.imageType,
      resource_id: bucket.resourceId
    }));

  let nextAnnId = 1;
  const cocoAnnotations: CocoAnnotationOut[] = [];
  for (const item of slice) {
    const cat = (item.ann as IimlAnnotation & { category?: string }).category;
    const categoryId = cat ? COCO_CATEGORY_ID_BY_NAME.get(cat) : undefined;
    if (!categoryId) continue; // 已在 validate 过滤掉，但双重保险
    const cocoAnn = convertToCocoAnn(
      item.ann,
      item.effectiveTarget,
      nextAnnId,
      item.bucket,
      categoryId
    );
    if (cocoAnn) {
      cocoAnnotations.push(cocoAnn);
      nextAnnId += 1;
    }
  }

  return {
    info: {
      description: `WSC3D ${DATASET_NAME} — ${splitName} split`,
      version: "0.1.0",
      split: splitName,
      year: new Date().getFullYear(),
      contributor: "WSC3D",
      date_created: exportedAt
    },
    licenses: [{ id: 1, name: "CC-BY-NC 4.0", url: "https://creativecommons.org/licenses/by-nc/4.0/" }],
    images,
    annotations: cocoAnnotations,
    categories: COCO_CATEGORIES
  };
}

function buildTypeSplit(
  imageType: ImageType,
  buckets: ImageBucket[],
  splits: { train: AcceptedAnn[]; val: AcceptedAnn[]; test: AcceptedAnn[] }
) {
  const trainStones = new Set(splits.train.map((a) => a.stoneId));
  const valStones = new Set(splits.val.map((a) => a.stoneId));
  const testStones = new Set(splits.test.map((a) => a.stoneId));
  return {
    description: `${imageType} 图像独立切分（按 stoneId 与主 split 一致）`,
    imageType,
    bucketCount: buckets.length,
    train: buckets.filter((b) => trainStones.has(b.stoneId)).map((b) => ({ imageId: b.imageId, stoneId: b.stoneId, fileName: b.cocoFileName })),
    val: buckets.filter((b) => valStones.has(b.stoneId)).map((b) => ({ imageId: b.imageId, stoneId: b.stoneId, fileName: b.cocoFileName })),
    test: buckets.filter((b) => testStones.has(b.stoneId)).map((b) => ({ imageId: b.imageId, stoneId: b.stoneId, fileName: b.cocoFileName }))
  };
}

function convertToCocoAnn(
  ann: IimlAnnotation,
  effectiveTarget: IimlGeometry,
  id: number,
  bucket: ImageBucket,
  categoryId: number
): CocoAnnotationOut | undefined {
  // 用反投影后的 effectiveTarget 计算几何，但 IIML 字段（id/label/motif 等）仍取自
  // 原 ann。frame 字段写"image"——COCO 消费方据此知道几何已统一在图像坐标系。
  const target = effectiveTarget;
  const imageId = bucket.imageId;
  // SOP §14：bbox/segmentation 用真实图像分辨率反归一化（以 width 为基），
  // 这样 COCO 消费方按 image.width/height 直接拿到像素坐标。
  // UV 是 [0,1]² 各向独立归一化，所以 x 用 width、y 用 height。
  const pixelW = bucket.width;
  const pixelH = bucket.height;
  const a = ann as IimlAnnotation & { category?: string; motif?: string; resourceId?: string };
  const provenance = (ann as IimlAnnotation & { provenance?: { author?: string } }).provenance;
  // effectiveTarget !== ann.target → 经过 model→image 反投影；消费方据 iiml_projected
  // 知道几何坐标系是 image，与 frame=image 等价。原 frame 仍保留在 iiml_frame 便于回查。
  const projectionApplied = effectiveTarget !== ann.target;
  const baseExtension: CocoAnnotationOut["extension"] = {
    iiml_id: ann.id,
    iiml_label: ann.label,
    iiml_motif: a.motif,
    iiml_structuralLevel: ann.structuralLevel,
    iiml_terms: (ann.semantics?.terms ?? []).map((t) => t.id),
    iiml_reviewStatus: ann.reviewStatus,
    iiml_resource_id: a.resourceId,
    iiml_provenance_author: provenance?.author,
    iiml_frame: ann.frame,
    iiml_projected: projectionApplied
  };

  if (target.type === "BBox") {
    const [u1, v1, u2, v2] = target.coordinates;
    const x = Math.min(u1, u2) * pixelW;
    const y = Math.min(v1, v2) * pixelH;
    const w = Math.abs(u2 - u1) * pixelW;
    const h = Math.abs(v2 - v1) * pixelH;
    return {
      id,
      image_id: imageId,
      category_id: categoryId,
      bbox: [x, y, w, h],
      area: w * h,
      iscrowd: 0,
      extension: baseExtension
    };
  }

  if (target.type === "Polygon" || target.type === "MultiPolygon") {
    const polygons = target.type === "Polygon" ? [target.coordinates] : target.coordinates;
    const segmentation: number[][] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let totalArea = 0;
    for (const polygon of polygons) {
      const ring = polygon[0];
      if (!ring || ring.length < 3) continue;
      const flat: number[] = [];
      for (const point of ring) {
        const x = Number(point[0] ?? 0) * pixelW;
        const y = Number(point[1] ?? 0) * pixelH;
        flat.push(x, y);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      segmentation.push(flat);
      totalArea += polygonAreaShoelace(flat);
    }
    if (segmentation.length === 0 || !Number.isFinite(minX)) return undefined;
    return {
      id,
      image_id: imageId,
      category_id: categoryId,
      bbox: [minX, minY, maxX - minX, maxY - minY],
      area: Math.abs(totalArea),
      iscrowd: 0,
      segmentation,
      extension: baseExtension
    };
  }

  // Point / LineString 不进 COCO
  return undefined;
}

function polygonAreaShoelace(flat: number[]): number {
  let area = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i += 1) {
    const x1 = flat[i * 2];
    const y1 = flat[i * 2 + 1];
    const x2 = flat[((i + 1) % n) * 2];
    const y2 = flat[((i + 1) % n) * 2 + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function buildStoneSplit(stoneIds: string[], splits: { train: AcceptedAnn[]; val: AcceptedAnn[]; test: AcceptedAnn[] }) {
  const trainSet = new Set(splits.train.map((a) => a.stoneId));
  const valSet = new Set(splits.val.map((a) => a.stoneId));
  const testSet = new Set(splits.test.map((a) => a.stoneId));
  return {
    description: "石头级 70/15/15 划分（防止同一画像石跨 split 数据泄漏）",
    seed: "djb2-deterministic",
    train: stoneIds.filter((id) => trainSet.has(id)),
    val: stoneIds.filter((id) => valSet.has(id)),
    test: stoneIds.filter((id) => testSet.has(id)),
    excluded: stoneIds.filter((id) => !trainSet.has(id) && !valSet.has(id) && !testSet.has(id))
  };
}

function buildMotifsManifest(accepted: AcceptedAnn[]) {
  const counts: Record<string, { count: number; categories: Record<string, number> }> = {};
  for (const item of accepted) {
    const a = item.ann as IimlAnnotation & { motif?: string; category?: string };
    const motif = (a.motif ?? "").trim();
    if (!motif) continue;
    if (!counts[motif]) counts[motif] = { count: 0, categories: {} };
    counts[motif].count += 1;
    const cat = a.category ?? "unknown";
    counts[motif].categories[cat] = (counts[motif].categories[cat] ?? 0) + 1;
  }
  const ordered = Object.entries(counts).sort((a, b) => b[1].count - a[1].count);
  return {
    description: "本次导出涉及的 motif 频次表（SOP §1.6 + 附录 A）",
    totalMotifs: ordered.length,
    items: ordered.map(([motif, info]) => ({ motif, count: info.count, byCategory: info.categories }))
  };
}

function buildStats(
  exportedAt: string,
  accepted: AcceptedAnn[],
  skipped: SkippedAnn[],
  splits: { train: AcceptedAnn[]; val: AcceptedAnn[]; test: AcceptedAnn[] },
  stones: StoneDocPair[],
  warningCounts: Record<string, number>
) {
  const stoneDistribution: Record<string, number> = {};
  for (const item of accepted) {
    stoneDistribution[item.stoneId] = (stoneDistribution[item.stoneId] ?? 0) + 1;
  }
  const errorCounts: Record<string, number> = {};
  for (const item of skipped) {
    for (const e of item.errors) errorCounts[e] = (errorCounts[e] ?? 0) + 1;
  }
  // 图像类型分布（按 bucket）：original / orthophoto / rubbing / ...
  const imageTypeDistribution: Record<string, number> = {};
  const seenBuckets = new Set<number>();
  for (const item of accepted) {
    if (seenBuckets.has(item.bucket.imageId)) continue;
    seenBuckets.add(item.bucket.imageId);
    imageTypeDistribution[item.bucket.imageType] =
      (imageTypeDistribution[item.bucket.imageType] ?? 0) + 1;
  }
  // 每条 ann 在哪类图像上（与 bucket 区分：一个 bucket 多 ann）
  const annPerImageType: Record<string, number> = {};
  for (const item of accepted) {
    annPerImageType[item.bucket.imageType] = (annPerImageType[item.bucket.imageType] ?? 0) + 1;
  }
  // 反投影统计
  const projectedCount = accepted.filter((a) => a.effectiveTarget !== a.ann.target).length;

  return {
    exportedAt,
    totalAnnotations: accepted.length + skipped.length,
    acceptedAnnotations: accepted.length,
    skippedAnnotations: skipped.length,
    totalStones: stones.length,
    splits: {
      train: splits.train.length,
      val: splits.val.length,
      test: splits.test.length
    },
    categoryDistribution: countCategoryDistribution(accepted),
    motifDistribution: countMotifDistribution(accepted),
    structuralLevelDistribution: countStructuralLevelDistribution(accepted),
    stoneDistribution,
    imageTypeDistribution,    // bucket 数量
    annotationsPerImageType: annPerImageType, // ann 数量
    projectedAnnotations: projectedCount, // 经 model→image 反投影的 ann 数
    skippedReasons: errorCounts,
    warnings: warningCounts
  };
}

function countCategoryDistribution(accepted: AcceptedAnn[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of accepted) {
    const cat = (item.ann as IimlAnnotation & { category?: string }).category ?? "unknown";
    out[cat] = (out[cat] ?? 0) + 1;
  }
  return out;
}

function countMotifDistribution(accepted: AcceptedAnn[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of accepted) {
    const motif = (item.ann as IimlAnnotation & { motif?: string }).motif?.trim();
    if (!motif) continue;
    out[motif] = (out[motif] ?? 0) + 1;
  }
  return out;
}

function countStructuralLevelDistribution(accepted: AcceptedAnn[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of accepted) {
    const lvl = item.ann.structuralLevel ?? "unknown";
    out[lvl] = (out[lvl] ?? 0) + 1;
  }
  return out;
}

function buildSourcesCsv(stones: StoneDocPair[]): string {
  const header = "stoneId,displayName,resourceId,resourceType,uri,description,acquisition,acquiredBy,acquiredAt";
  const rows: string[] = [header];
  for (const stone of stones) {
    for (const r of stone.doc.resources ?? []) {
      const row = [
        csvCell(stone.stoneId),
        csvCell(getDisplayName(stone.doc)),
        csvCell(r.id),
        csvCell(r.type),
        csvCell(String(r.uri ?? "")),
        csvCell(asString((r as Record<string, unknown>).description)),
        csvCell(asString((r as Record<string, unknown>).acquisition)),
        csvCell(asString((r as Record<string, unknown>).acquiredBy)),
        csvCell(asString((r as Record<string, unknown>).acquiredAt))
      ].join(",");
      rows.push(row);
    }
  }
  return rows.join("\n");
}

function buildRelationsJsonl(stones: StoneDocPair[]): string {
  const lines: string[] = [];
  for (const stone of stones) {
    for (const rel of stone.doc.relations ?? []) {
      const wrapped = { stoneId: stone.stoneId, ...(rel as Record<string, unknown>) };
      lines.push(JSON.stringify(wrapped));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function buildReportCsv(
  accepted: AcceptedAnn[],
  skipped: SkippedAnn[],
  splits: { train: AcceptedAnn[]; val: AcceptedAnn[]; test: AcceptedAnn[] }
): string {
  const splitOf = new Map<string, "train" | "val" | "test">();
  for (const item of splits.train) splitOf.set(`${item.stoneId}|${item.ann.id}`, "train");
  for (const item of splits.val) splitOf.set(`${item.stoneId}|${item.ann.id}`, "val");
  for (const item of splits.test) splitOf.set(`${item.stoneId}|${item.ann.id}`, "test");

  const header =
    "stoneId,annotationId,decision,split,errors,category,motif,structuralLevel,reviewStatus,label,imageType,imageId,frame,projected";
  const rows: string[] = [header];

  for (const item of accepted) {
    const a = item.ann as IimlAnnotation & { category?: string; motif?: string };
    const projected = item.effectiveTarget !== item.ann.target;
    rows.push(
      [
        csvCell(item.stoneId),
        csvCell(item.ann.id),
        "accepted",
        csvCell(splitOf.get(`${item.stoneId}|${item.ann.id}`) ?? ""),
        "",
        csvCell(a.category ?? ""),
        csvCell(a.motif ?? ""),
        csvCell(item.ann.structuralLevel ?? ""),
        csvCell(item.ann.reviewStatus ?? ""),
        csvCell(item.ann.label ?? ""),
        csvCell(item.bucket.imageType),
        String(item.bucket.imageId),
        csvCell(item.ann.frame ?? "model"),
        projected ? "yes" : "no"
      ].join(",")
    );
  }
  for (const item of skipped) {
    const a = item.ann as IimlAnnotation & { category?: string; motif?: string };
    rows.push(
      [
        csvCell(item.stoneId),
        csvCell(item.ann.id),
        "skipped",
        "",
        csvCell(item.errors.join(";")),
        csvCell(a.category ?? ""),
        csvCell(a.motif ?? ""),
        csvCell(item.ann.structuralLevel ?? ""),
        csvCell(item.ann.reviewStatus ?? ""),
        csvCell(item.ann.label ?? ""),
        "",
        "",
        csvCell(item.ann.frame ?? "model"),
        ""
      ].join(",")
    );
  }
  return rows.join("\n");
}

function buildQualityWarningsCsv(
  accepted: AcceptedAnn[],
  warningCounts: Record<string, number>,
  imageQualityWarnings: Array<{ stoneId: string; resourceId: string; reason: string; detail?: string }>
): string {
  const header = "stoneId,annotationId,warning,category,motif,label,detail";
  const rows: string[] = [header];

  // 1. annotation 级警告：故事类缺 motif
  for (const item of accepted) {
    const a = item.ann as IimlAnnotation & { category?: string; motif?: string };
    if (
      a.category &&
      ["figure-loyal-assassin", "figure-filial-son", "figure-virtuous-woman"].includes(a.category) &&
      !(a.motif && a.motif.trim())
    ) {
      rows.push(
        [
          csvCell(item.stoneId),
          csvCell(item.ann.id),
          "missing-motif-for-narrative",
          csvCell(a.category),
          "",
          csvCell(item.ann.label ?? ""),
          ""
        ].join(",")
      );
    }
  }

  // 2. 图像级警告：低分辨率 / 缺文件（来自 resolveImageBucket）
  for (const w of imageQualityWarnings) {
    rows.push(
      [
        csvCell(w.stoneId),
        csvCell(w.resourceId),
        csvCell(w.reason),
        "",
        "",
        "",
        csvCell(w.detail ?? "")
      ].join(",")
    );
  }
  // 头部加一行注释（# 开头），方便人读
  const summary = Object.entries(warningCounts).map(([k, v]) => `${k}=${v}`).join("; ");
  return `# 质量警告统计：${summary || "（无）"}\n${rows.join("\n")}`;
}

function buildReadme(exportedAt: string, totalStones: number, totalAccepted: number): string {
  return [
    `# ${DATASET_NAME}`,
    "",
    "WSC3D 平台 M5 Phase 1（A2 主动学习闭环）训练池数据集。",
    "",
    `- 导出时间：\`${exportedAt}\``,
    `- 涉及画像石数量：${totalStones}`,
    `- 训练池命中标注数量：${totalAccepted}`,
    "",
    "## 目录结构",
    "",
    "见 SOP `docs/han-stone-annotation-SOP.md` §14。当前版本：",
    "",
    "- `annotations/coco_train.json` / `coco_val.json` / `coco_test.json`：COCO 三套划分（70/15/15，按 stoneId 划分防泄漏）",
    "- `annotations/coco_categories.json`：13 类 + unknown（id 1-14；unknown 不进入 COCO 训练）",
    "- `annotations/motifs.json`：本次涉及的 motif 频次表",
    "- `annotations/splits/stone_split.json`：stoneId → split 完整映射",
    "- `iiml/{stoneId}.iiml.json`：完整 IIML 备份（保留 IIML 链路）",
    "- `relations/relations_all.jsonl`：跨石头关系全集（图谱训练用）",
    "- `images/original/{stoneId}/`：**目录占位**。实际图像文件未复制，",
    "  COCO `file_name` 字段引用 `original/{stoneId}/main.png` 相对路径，",
    "  训练时由 ML 工程师按 `SOURCES.csv` 把 `data/stone-resources/{stoneId}/`",
    "  里的 PNG 链接 / 复制到这里。",
    "- `SOURCES.csv`：每张图来源 / 摄影者 / 拓制者 / 授权状态",
    "- `stats.json`：完整统计（类别 / motif / 层级 / stone / 跳过原因）",
    "- `reports/export_*.csv`：本次每条 annotation 的 accepted / skipped 决策 + 原因",
    "- `reports/quality_warnings.csv`：故事类缺 motif 等质量警告",
    "",
    "## License",
    "",
    "训练用途：CC-BY-NC 4.0。详见 `SOURCES.csv` 每条记录的授权状态。",
    "",
    "## 训练用法",
    "",
    "```bash",
    "# YOLOv8 / YOLO11",
    "yolo train data=coco_train.json model=yolo11n.pt",
    "",
    "# Detectron2",
    "from detectron2.data.datasets import register_coco_instances",
    `register_coco_instances("${DATASET_NAME}-train", {}, "annotations/coco_train.json", "images/original")`,
    "```"
  ].join("\n");
}

// =============================================================================
// 辅助
// =============================================================================

function csvCell(value: string): string {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function renameDir(from: string, to: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.rename(from, to);
}
