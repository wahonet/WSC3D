/**
 * 画像石资源目录扫描与匹配
 *
 * 后端启动后第一次调用 `getCatalog` 时会扫描三个核心目录：
 * - `temp/`（或 `WSC3D_MODEL_DIR`）：三维模型 `.gltf` / `.glb` 等 + 缩略图 PNG
 * - `画像石结构化分档/`（或 `WSC3D_METADATA_DIR`）：每块石头一份 Markdown 档案
 * - `参考图/`（或 `WSC3D_REFERENCE_DIR`）：UI 参考截图
 *
 * 输出：
 * - `summary`：模型 / 缩略图 / 文档总数与未配对计数
 * - `stones[]`：以 stoneId 为 key，关联一份 metadata + 一份模型 + 一张缩略图
 * - `referenceImages`：参考图列表
 *
 * 匹配规则（按顺序尝试）：
 * 1. **名称归一化**：去掉前缀数字 / 标点 / 空白后做 substring 双向匹配
 * 2. **数字前缀**：把模型文件名的 `^\d+` 与 metadata 的 `stone_id` 对齐（多数
 *    历史命名是 `29东汉武氏祠...` 这种带前缀）
 *
 * 设计要点：
 * - 整份 catalog cache 在内存，仅 `force = true` 时（如 POST /api/scan/refresh）
 *   重建；服务器进程重启自然清空
 * - `parseMarkdownMetadata` 解析 Markdown，返回带 layers / panels 的结构化对象
 * - 找不到模型 / 缩略图时仍然产出 stone 记录（`hasModel: false`），让前端可
 *   提示用户哪些档案缺资源
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetFile, Catalog, CatalogHealth, StoneMetadata, StoneRecord } from "../types.js";
import { parseMarkdownMetadata } from "../parsers/markdownParser.js";
import { loadCatalogOverride, type OverrideApplication } from "./catalog-override.js";

const modelExtensions = new Set([".gltf", ".glb", ".obj", ".fbx", ".ply"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export type CatalogConfig = {
  rootDir: string;
  modelDir: string;
  metadataDir: string;
  referenceDir: string;
};

let cachedCatalog: Catalog | undefined;

export async function getCatalog(config: CatalogConfig, force = false): Promise<Catalog> {
  if (!cachedCatalog || force) {
    cachedCatalog = await buildCatalog(config);
  }
  return cachedCatalog;
}

async function buildCatalog(config: CatalogConfig): Promise<Catalog> {
  const modelAssets = await listFiles(config.modelDir, modelExtensions);
  const thumbnails = await listFiles(config.modelDir, imageExtensions);
  const referenceImages = await listFiles(config.referenceDir, imageExtensions);
  const metadataFilesAll = await listFiles(config.metadataDir, new Set([".md"]));

  // 0. 加载 catalog override（强制配对 + 黑名单）
  const { override, sourcePath: overrideSourcePath } = await loadCatalogOverride(config.rootDir);
  const dropMetadataSet = new Set((override.dropMetadata ?? []).map((r) => r.sourceFile));
  const dropOrphanSet = new Set((override.dropOrphan ?? []).map((r) => r.modelFileName));

  // 用 dropMetadata 黑名单过滤 .md 档案
  const metadataFiles = metadataFilesAll.filter((file) => !dropMetadataSet.has(file.fileName));
  const metadata = await Promise.all(metadataFiles.map((file) => parseMarkdownMetadata(file.path)));

  const thumbnailByBaseName = new Map(thumbnails.map((file) => [baseName(file.fileName), file]));
  const modelCandidates = modelAssets.map((model) => ({
    model,
    readableName: readableNameFromModel(model.fileName),
    normalizedName: normalizeName(readableNameFromModel(model.fileName)),
    numericPrefix: numericPrefix(model.fileName)
  }));
  const modelByFileName = new Map(modelCandidates.map((c) => [c.model.fileName, c]));

  const usedModels = new Set<string>();
  let metadataWithModel = 0;
  const stones: StoneRecord[] = [];

  // 1. 应用 forceMatch override：先把所有显式配对锁死，后续模糊匹配不能再动这些模型。
  //    - modelFileName === null：这块石头明确没有匹配的模型（不要被相邻模型误抢）
  //    - 命中的规则 + 找不到模型 / 模型已被同 stoneId 占用 → 进 unrecognized
  const application: OverrideApplication = {
    appliedForceMatches: [],
    appliedDropMetadata: (override.dropMetadata ?? []).filter((r) =>
      metadataFilesAll.some((f) => f.fileName === r.sourceFile)
    ),
    appliedDropOrphan: (override.dropOrphan ?? []).filter((r) =>
      modelByFileName.has(r.modelFileName)
    ),
    unrecognizedRules: []
  };

  // 收集每条 metadata 的 forceMatch（按 stoneId 索引）
  const forceMatchByStoneId = new Map<string, { modelFileName: string | null; note?: string }>();
  for (const rule of override.forceMatch ?? []) {
    if (rule.modelFileName !== null && !modelByFileName.has(rule.modelFileName)) {
      application.unrecognizedRules.push({ kind: "forceMatch", rule });
      continue;
    }
    forceMatchByStoneId.set(rule.stoneId, { modelFileName: rule.modelFileName, note: rule.note });
    application.appliedForceMatches.push(rule);
  }
  for (const rule of override.dropMetadata ?? []) {
    if (!metadataFilesAll.some((f) => f.fileName === rule.sourceFile)) {
      application.unrecognizedRules.push({ kind: "dropMetadata", rule });
    }
  }
  for (const rule of override.dropOrphan ?? []) {
    if (!modelByFileName.has(rule.modelFileName)) {
      application.unrecognizedRules.push({ kind: "dropOrphan", rule });
    }
  }

  // 2. 遍历 metadata，先 forceMatch，否则走原模糊匹配 + 数字前缀兜底
  for (const item of metadata) {
    let model: AssetFile | undefined;
    const forced = forceMatchByStoneId.get(item.stone_id);
    if (forced) {
      if (forced.modelFileName === null) {
        // 显式跳过：保留 hasModel=false，避免被相邻模型误抢
        model = undefined;
      } else {
        const candidate = modelByFileName.get(forced.modelFileName);
        if (candidate && !usedModels.has(candidate.model.path)) {
          model = candidate.model;
          usedModels.add(candidate.model.path);
          metadataWithModel += 1;
        }
      }
    } else {
      const metadataName = normalizeName(item.name);
      const candidate =
        modelCandidates.find(
          ({ model: m, normalizedName }) =>
            !usedModels.has(m.path) &&
            !dropOrphanSet.has(m.fileName) &&
            (normalizedName === metadataName ||
              normalizedName.includes(metadataName) ||
              metadataName.includes(normalizedName))
        ) ??
        modelCandidates.find(
          ({ model: m, numericPrefix }) =>
            !usedModels.has(m.path) &&
            !dropOrphanSet.has(m.fileName) &&
            numericPrefix?.padStart(2, "0") === item.stone_id
        );
      if (candidate) {
        model = candidate.model;
        usedModels.add(candidate.model.path);
        metadataWithModel += 1;
      }
    }

    stones.push(createStoneRecord(item.stone_id, item.name, item, model, thumbnailByBaseName));
  }

  // 3. 处理 forceMatch 里"asset-XX → 某模型"的情况（把孤儿模型扶正成正式 stone）
  for (const rule of override.forceMatch ?? []) {
    if (!rule.stoneId.startsWith("asset-")) continue;
    if (rule.modelFileName === null) continue;
    const candidate = modelByFileName.get(rule.modelFileName);
    if (!candidate || usedModels.has(candidate.model.path)) continue;
    usedModels.add(candidate.model.path);
    stones.push(
      createStoneRecord(rule.stoneId, candidate.readableName, undefined, candidate.model, thumbnailByBaseName)
    );
  }

  // 4. 剩余的孤儿模型（没被 metadata / forceMatch 用上，且不在 dropOrphan 黑名单）→ asset-XX
  const orphanModelEntries: Array<{ fallbackId: string; modelFileName: string }> = [];
  for (const candidate of modelCandidates) {
    if (usedModels.has(candidate.model.path)) continue;
    if (dropOrphanSet.has(candidate.model.fileName)) continue;
    const fallbackId = candidate.numericPrefix
      ? `asset-${candidate.numericPrefix.padStart(2, "0")}`
      : `asset-${slugify(baseName(candidate.model.fileName))}`;
    stones.push(createStoneRecord(fallbackId, candidate.readableName, undefined, candidate.model, thumbnailByBaseName));
    orphanModelEntries.push({ fallbackId, modelFileName: candidate.model.fileName });
  }

  stones.sort((a, b) => sortKey(a.id) - sortKey(b.id) || a.displayName.localeCompare(b.displayName, "zh-Hans-CN"));

  // 5. health 报告：unmatchedMetadata + numericKey 冲突
  const unmatchedMetadata = stones
    .filter((s) => s.metadata && !s.hasModel)
    .map((s) => ({
      stoneId: s.id,
      sourceFile: s.metadata?.source_file ?? "",
      displayName: s.displayName
    }));
  const numericKeyConflicts = computeNumericKeyConflicts(stones);

  const health: CatalogHealth = {
    overrideSourcePath,
    appliedForceMatches: application.appliedForceMatches,
    appliedDropMetadata: application.appliedDropMetadata,
    appliedDropOrphan: application.appliedDropOrphan,
    unrecognizedRules: application.unrecognizedRules,
    unmatchedMetadata,
    orphanModels: orphanModelEntries,
    numericKeyConflicts
  };

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      modelDir: config.modelDir,
      metadataDir: config.metadataDir,
      referenceDir: config.referenceDir,
      modelCount: modelAssets.length,
      thumbnailCount: thumbnails.length,
      markdownCount: metadataFilesAll.length,
      referenceImageCount: referenceImages.length,
      modelExtensions: countExtensions(modelAssets),
      unmatchedModels: modelAssets.length - usedModels.size - dropOrphanSet.size,
      unmatchedMetadata: metadata.length - metadataWithModel
    },
    stones,
    referenceImages,
    health
  };
}

/**
 * 同 numericKey 多 stone 冲突。常见来源：
 *   - `asset-32` + `32` 同时存在 → key="32"，pic 配对会都命中，无法区分
 *   - `asset-44` + `44` 类似
 * 解决方法：dropOrphan 删 asset-XX，或 forceMatch 把它扶正成 stoneId=="32"。
 */
function computeNumericKeyConflicts(stones: StoneRecord[]): Array<{ key: string; stoneIds: string[] }> {
  const byKey = new Map<string, string[]>();
  for (const s of stones) {
    const m = s.id.match(/(\d+)/);
    if (!m) continue;
    const key = m[1].replace(/^0+/, "") || "0";
    const arr = byKey.get(key) ?? [];
    arr.push(s.id);
    byKey.set(key, arr);
  }
  return Array.from(byKey.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([key, stoneIds]) => ({ key, stoneIds }));
}

function createStoneRecord(
  id: string,
  name: string,
  metadata: StoneMetadata | undefined,
  model: AssetFile | undefined,
  thumbnailByBaseName: Map<string, AssetFile>
): StoneRecord {
  const thumbnail = model ? thumbnailByBaseName.get(baseName(model.fileName)) : undefined;

  return {
    id,
    name,
    displayName: metadata?.name ?? name,
    model,
    thumbnail,
    metadata,
    hasModel: Boolean(model),
    hasMetadata: Boolean(metadata),
    modelUrl: model ? `/assets/models/${encodeURIComponent(model.fileName)}` : undefined,
    thumbnailUrl: thumbnail ? `/assets/models/${encodeURIComponent(thumbnail.fileName)}` : undefined
  };
}

async function listFiles(directory: string, extensions: Set<string>): Promise<AssetFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const fileStat = await stat(filePath);
        return {
          fileName: entry.name,
          path: filePath,
          size: fileStat.size,
          extension: path.extname(entry.name).toLowerCase()
        };
      })
  );

  return files.sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-Hans-CN", { numeric: true }));
}

function countExtensions(files: AssetFile[]): Record<string, number> {
  return files.reduce<Record<string, number>>((acc, file) => {
    acc[file.extension] = (acc[file.extension] ?? 0) + 1;
    return acc;
  }, {});
}

function readableNameFromModel(fileName: string): string {
  return baseName(fileName)
    .replace(/^\d+[_-]?/, "")
    .replace(/^嘉祥武氏墓群石刻画像石/, "")
    .replace(/画像石$/u, "")
    .trim();
}

function normalizeName(value: string): string {
  return value
    .replace(/^\d+[._、\s-]*/u, "")
    .replace(/嘉祥武氏墓群石刻画像石/gu, "")
    .replace(/[东西南北]?汉/gu, "")
    .replace(/画像石|石刻|残石|造像碑/gu, "")
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
    .trim();
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "");
}

function numericPrefix(fileName: string): string | undefined {
  return fileName.match(/^(\d+)/)?.[1];
}

function sortKey(id: string): number {
  const numeric = id.match(/\d+/)?.[0];
  return numeric ? Number(numeric) : Number.MAX_SAFE_INTEGER;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
