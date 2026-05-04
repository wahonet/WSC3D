/**
 * Catalog 配对 override 加载器
 *
 * 仓库历史上 `temp/`（模型）和 `画像石结构化分档/`（metadata）的编号体系不严格
 * 一致：模型编号比 metadata 偏 1（temp 跳号 20）、个别 metadata 题目用字与模型
 * 不完全相同（如 metadata 37 "东北墓门" vs 模型 38 "东北墓间"），少数模型无对应
 * metadata（asset-47 隋开皇造像碑等）。
 *
 * `catalog.ts` 默认走"normalizedName 双向 includes + 数字前缀"模糊匹配，在编号
 * 错位的数据上会把 metadata N 错配到模型 N+1（看起来"对了"但是侥幸）。一旦用户
 * 重命名 / 替换文件，模糊匹配立即失稳。
 *
 * 解决思路：
 * - 用户在 `data/catalog.override.json` 写显式配对 + 忽略名单
 * - `catalog.ts` 先应用 override（forceMatch / dropMetadata / dropOrphan），剩下
 *   的资源再走原模糊匹配
 * - override 里有任何未识别的 stoneId / fileName 都会通过 `unrecognizedRules`
 *   暴露给 health 接口，避免静默失效
 *
 * 文件位置（按优先级查找）：
 *   1. `data/catalog.override.json`
 *   2. `catalog.override.json`（项目根，方便临时调试）
 *
 * 没有 override 文件时 catalog 行为完全等同 v0.3.0（向后兼容）。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type CatalogOverride = {
  /**
   * 强制配对：把指定 stoneId 与某个 model fileName 对死。
   * `modelFileName` = 文件名（含扩展名），相对 `WSC3D_MODEL_DIR`（默认 temp/）。
   * `modelFileName === null` 表示"该 stone 明确没有匹配的模型"，跳过模糊匹配
   *   并保持 hasModel=false（避免误抢相邻模型）。
   * `stoneId` 通常是补 0 的 metadata id（如 "31"），也可以是 fallback 形式
   *   `asset-XX`，便于把孤儿模型重命名为正式 stone。
   */
  forceMatch?: Array<{ stoneId: string; modelFileName: string | null; note?: string }>;

  /**
   * 元数据黑名单：跳过这些 .md 档案，不建立 stone 记录。
   * 适用场景：档案残缺到无法标注 / 重复档案 / 用户决定不在本数据集范围内。
   * 用 `source_file`（文件名）匹配。
   */
  dropMetadata?: Array<{ sourceFile: string; note?: string }>;

  /**
   * 模型黑名单：跳过这些 .gltf / .glb 文件，不为它们生成 fallback `asset-XX` 记录。
   * 适用场景：与画像石数据集无关的模型（如 47 号隋开皇造像碑）、
   * 仅作研究参考的孤儿模型、损坏文件等。
   */
  dropOrphan?: Array<{ modelFileName: string; note?: string }>;
};

export type LoadedOverride = {
  override: CatalogOverride;
  /** 实际从哪个文件读出的；用于 health 报告显示给用户 */
  sourcePath?: string;
};

const CANDIDATE_PATHS = ["data/catalog.override.json", "catalog.override.json"];

export async function loadCatalogOverride(projectRoot: string): Promise<LoadedOverride> {
  for (const rel of CANDIDATE_PATHS) {
    const fullPath = path.join(projectRoot, rel);
    try {
      const raw = await readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as CatalogOverride;
      return {
        override: normalizeOverride(parsed),
        sourcePath: fullPath
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      // eslint-disable-next-line no-console
      console.warn(`[catalog-override] parse failed at ${fullPath}: ${(error as Error).message}`);
    }
  }
  return { override: { forceMatch: [], dropMetadata: [], dropOrphan: [] }, sourcePath: undefined };
}

function normalizeOverride(raw: CatalogOverride): CatalogOverride {
  return {
    forceMatch: Array.isArray(raw.forceMatch) ? raw.forceMatch : [],
    dropMetadata: Array.isArray(raw.dropMetadata) ? raw.dropMetadata : [],
    dropOrphan: Array.isArray(raw.dropOrphan) ? raw.dropOrphan : []
  };
}

export type OverrideApplication = {
  /** 实际命中的 forceMatch 规则 */
  appliedForceMatches: Array<{ stoneId: string; modelFileName: string | null; note?: string }>;
  /** 命中的 dropMetadata 规则 */
  appliedDropMetadata: Array<{ sourceFile: string; note?: string }>;
  /** 命中的 dropOrphan 规则 */
  appliedDropOrphan: Array<{ modelFileName: string; note?: string }>;
  /** 配置里写了但没匹配上的规则（拼写错误 / 文件已删除等） */
  unrecognizedRules: Array<{ kind: "forceMatch" | "dropMetadata" | "dropOrphan"; rule: unknown }>;
};
