/**
 * 画像石资源目录扫描
 *
 * 后端启动后第一次调用 `getCatalog` 时会扫描三个核心目录：
 * - `temp/`（或 `WSC3D_MODEL_DIR`）：三维模型 `.gltf` / `.glb` 等 + 缩略图 PNG
 * - `画像石结构化分档/`（或 `WSC3D_METADATA_DIR`）：历史 Markdown 档案，仅统计数量
 * - `参考图/`（或 `WSC3D_REFERENCE_DIR`）：UI 参考截图
 *
 * 输出：
 * - `summary`：模型 / 缩略图 / 文档总数
 * - `stones[]`：严格以 `temp/` 里的模型为基础数据生成，每个模型一条 stone
 * - `referenceImages`：参考图列表
 *
 * 设计要点：
 * - 整份 catalog cache 在内存，仅 `force = true` 时（如 POST /api/scan/refresh）
 *   重建；服务器进程重启自然清空
 * - 不再读取 Markdown 简介做模型配对，避免旧档案标题错位导致画像石列表乱序
 * - 后端为每个模型返回空 `metadata.layers`，前端简介显示“暂无简介”，后续可手动补录
 */

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { AssetFile, Catalog, CatalogHealth, StoneMetadata, StoneRecord } from "../types.js";

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
  const [modelAssets, thumbnails, referenceImages, metadataFilesAll] = await Promise.all([
    listFiles(config.modelDir, modelExtensions),
    listFiles(config.modelDir, imageExtensions),
    listFiles(config.referenceDir, imageExtensions),
    listFiles(config.metadataDir, new Set([".md"]))
  ]);

  const thumbnailByBaseName = new Map(thumbnails.map((file) => [baseName(file.fileName), file]));
  const stones = modelAssets.map((model) => {
    const id = stoneIdFromModel(model.fileName);
    const displayName = displayNameFromModel(model.fileName);
    const metadata = createEmptyMetadata(id, displayName, model.fileName);
    return createStoneRecord(id, displayName, metadata, model, thumbnailByBaseName);
  });
  stones.sort((a, b) => sortKey(a.id) - sortKey(b.id) || a.displayName.localeCompare(b.displayName, "zh-Hans-CN"));

  const numericKeyConflicts = computeNumericKeyConflicts(stones);

  const health: CatalogHealth = {
    appliedForceMatches: [],
    appliedDropMetadata: [],
    appliedDropOrphan: [],
    unrecognizedRules: [],
    unmatchedMetadata: [],
    orphanModels: [],
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
      unmatchedModels: 0,
      unmatchedMetadata: 0
    },
    stones,
    referenceImages,
    health
  };
}

/**
 * 同 numericKey 多 stone 冲突。模型列表现在由 temp/ 直接生成，正常情况下不应出现；
 * 若将来加入无数字前缀或重复数字前缀的模型，这里仍然会在 health 中提示。
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
    displayName: name,
    model,
    thumbnail,
    metadata,
    hasModel: Boolean(model),
    hasMetadata: Boolean(metadata?.layers.length),
    modelUrl: model ? `/assets/models/${encodeAssetPath(model.fileName)}` : undefined,
    thumbnailUrl: thumbnail ? `/assets/models/${encodeAssetPath(thumbnail.fileName)}` : undefined
  };
}

async function listFiles(directory: string, extensions: Set<string>): Promise<AssetFile[]> {
  const files: AssetFile[] = [];

  async function walk(currentDir: string, relativeDir = ""): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const relativeName = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const filePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(filePath, relativeName);
          return;
        }
        if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) return;
        const fileStat = await stat(filePath);
        files.push({
          fileName: relativeName,
          path: filePath,
          size: fileStat.size,
          extension: path.extname(entry.name).toLowerCase()
        });
      })
    );
  }

  await walk(directory);

  return files.sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-Hans-CN", { numeric: true }));
}

function countExtensions(files: AssetFile[]): Record<string, number> {
  return files.reduce<Record<string, number>>((acc, file) => {
    acc[file.extension] = (acc[file.extension] ?? 0) + 1;
    return acc;
  }, {});
}

function createEmptyMetadata(stoneId: string, displayName: string, modelFileName: string): StoneMetadata {
  return {
    stone_id: stoneId,
    name: displayName,
    dimensions: {
      unit: "cm",
      order: "height_width_thickness"
    },
    layers: [],
    source_file: modelFileName
  };
}

function baseName(fileName: string): string {
  return path.basename(fileName).replace(/\.[^.]+$/u, "");
}

function displayNameFromModel(fileName: string): string {
  return baseName(fileName).replace(/^\d+[_-]?/u, "").trim();
}

function stoneIdFromModel(fileName: string): string {
  const numeric = numericPrefix(fileName);
  return numeric ? numeric.padStart(2, "0") : `asset-${slugify(baseName(fileName))}`;
}

function numericPrefix(fileName: string): string | undefined {
  return path.basename(fileName).match(/^(\d+)/)?.[1];
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

function encodeAssetPath(relativePath: string): string {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}
