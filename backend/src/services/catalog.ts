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
import type { AssetFile, Catalog, StoneMetadata, StoneRecord } from "../types.js";
import { parseMarkdownMetadata } from "../parsers/markdownParser.js";

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
  const metadataFiles = await listFiles(config.metadataDir, new Set([".md"]));
  const metadata = await Promise.all(metadataFiles.map((file) => parseMarkdownMetadata(file.path)));

  const thumbnailByBaseName = new Map(thumbnails.map((file) => [baseName(file.fileName), file]));
  const modelCandidates = modelAssets.map((model) => ({
    model,
    readableName: readableNameFromModel(model.fileName),
    normalizedName: normalizeName(readableNameFromModel(model.fileName)),
    numericPrefix: numericPrefix(model.fileName)
  }));

  const usedModels = new Set<string>();
  const usedMetadata = new Set<string>();
  let metadataWithModel = 0;
  const stones: StoneRecord[] = [];

  for (const item of metadata) {
    const metadataName = normalizeName(item.name);
    const candidate =
      modelCandidates.find(
        ({ model, normalizedName }) =>
          !usedModels.has(model.path) &&
          (normalizedName === metadataName ||
            normalizedName.includes(metadataName) ||
            metadataName.includes(normalizedName))
      ) ??
      modelCandidates.find(
        ({ model, numericPrefix }) =>
          !usedModels.has(model.path) && numericPrefix?.padStart(2, "0") === item.stone_id
      );

    const model = candidate?.model;
    if (model) {
      usedModels.add(model.path);
      metadataWithModel += 1;
    }
    usedMetadata.add(item.stone_id);
    stones.push(createStoneRecord(item.stone_id, item.name, item, model, thumbnailByBaseName));
  }

  for (const candidate of modelCandidates) {
    if (usedModels.has(candidate.model.path)) {
      continue;
    }
    const fallbackId = candidate.numericPrefix
      ? `asset-${candidate.numericPrefix.padStart(2, "0")}`
      : `asset-${slugify(baseName(candidate.model.fileName))}`;
    stones.push(createStoneRecord(fallbackId, candidate.readableName, undefined, candidate.model, thumbnailByBaseName));
  }

  stones.sort((a, b) => sortKey(a.id) - sortKey(b.id) || a.displayName.localeCompare(b.displayName, "zh-Hans-CN"));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      modelDir: config.modelDir,
      metadataDir: config.metadataDir,
      referenceDir: config.referenceDir,
      modelCount: modelAssets.length,
      thumbnailCount: thumbnails.length,
      markdownCount: metadataFiles.length,
      referenceImageCount: referenceImages.length,
      modelExtensions: countExtensions(modelAssets),
      unmatchedModels: modelAssets.length - usedModels.size,
      unmatchedMetadata: metadata.length - metadataWithModel
    },
    stones,
    referenceImages
  };
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
