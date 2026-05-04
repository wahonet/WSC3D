/**
 * 标注上线前预检（M5 Phase 1 D 阶段）
 *
 * 一次接口跑全：pic/ 配对、IIML 完整度、训练池可用性、类别均衡度。批量标注前
 * 用户点"预检"按钮拿这份报告，决定先干哪件事（补图 / 补 category / 改 frame
 * 标注等）。
 *
 * 设计要点：
 * - 不依赖 ai-service：图像质量门槛单走 `/ai/quality/{stoneId}`，标员另行调用
 * - 不写盘：纯只读聚合
 * - 单次扫全部 IIML + pic + catalog，对 ~50 块石头 < 1s
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CatalogConfig, getCatalog } from "./catalog.js";
import type { IimlAnnotation, IimlDocument } from "./iiml.js";
import { getPicDir, scanPicDir, stoneIdToNumericKey } from "./pic.js";
import {
  getAlignmentFromDoc,
  isEquivalentOrthophotoResource,
  validateAnnotationForTraining
} from "./training-validation.js";

type CatalogLoader = typeof getCatalog;

export type PreflightReport = {
  generatedAt: string;
  catalog: {
    overrideSourcePath?: string;
    totalStones: number;
    stonesWithModel: number;
    stonesWithMetadata: number;
    orphanModelCount: number;
    unmatchedMetadataCount: number;
    numericKeyConflictCount: number;
    unrecognizedRuleCount: number;
    /** 显式列出每条冲突，方便用户改 override */
    numericKeyConflicts: Array<{ key: string; stoneIds: string[] }>;
    orphanModels: Array<{ fallbackId: string; modelFileName: string }>;
    unmatchedMetadata: Array<{ stoneId: string; sourceFile: string; displayName: string }>;
  };
  pic: {
    picDir: string;
    exists: boolean;
    totalFiles: number;
    matchedCount: number;
    matched: Array<{ stoneId: string; fileName: string }>;
    unmatchedStones: string[];
    duplicateKeys: Array<{ key: string; fileNames: string[] }>;
    unrecognizedFiles: string[];
  };
  iiml: {
    totalDocs: number;
    annotationsTotal: number;
    missingCategoryCount: number;
    missingMotifInNarrativeCount: number;
    frameModelNoAlignmentCount: number;
    reviewStatusBreakdown: Record<string, number>;
  };
  trainingReadiness: {
    estimatedAccepted: number;
    estimatedSkipped: number;
    skipReasonTop: Array<{ reason: string; count: number }>;
    categoryDistribution: Record<string, number>;
    underrepresentedCategories: string[];
  };
};

const NARRATIVE_CATEGORIES = new Set([
  "figure-loyal-assassin",
  "figure-filial-son",
  "figure-virtuous-woman"
]);

// 类别样本不足阈值：低于这个数会在 underrepresentedCategories 高亮
const CATEGORY_MIN_SAMPLES = 30;

export async function runPreflight(
  projectRoot: string,
  catalogConfig: CatalogConfig,
  getCatalogImpl: CatalogLoader
): Promise<PreflightReport> {
  const generatedAt = new Date().toISOString();

  // 1) pic + catalog
  const [picHealth, catalog] = await Promise.all([
    scanPicDir(getPicDir(projectRoot)),
    getCatalogImpl(catalogConfig)
  ]);
  const matched: Array<{ stoneId: string; fileName: string }> = [];
  const unmatchedStones: string[] = [];
  for (const stone of catalog.stones) {
    const key = stoneIdToNumericKey(stone.id);
    if (key && picHealth.byNumericKey[key]?.length) {
      matched.push({ stoneId: stone.id, fileName: picHealth.byNumericKey[key][0].fileName });
    } else {
      unmatchedStones.push(stone.id);
    }
  }

  // 2) IIML 全扫
  const iimlDir = path.join(projectRoot, "data", "iiml");
  let entries: string[] = [];
  try {
    entries = await readdir(iimlDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const docs: IimlDocument[] = [];
  for (const fileName of entries.filter((n) => n.endsWith(".iiml.json"))) {
    try {
      const raw = await readFile(path.join(iimlDir, fileName), "utf8");
      docs.push(JSON.parse(raw) as IimlDocument);
    } catch {
      // 解析失败的 IIML 不计入预检（saveIimlDoc 路径会拦下，单独纠错）
    }
  }

  let annotationsTotal = 0;
  let missingCategoryCount = 0;
  let missingMotifInNarrativeCount = 0;
  let frameModelNoAlignmentCount = 0;
  const reviewStatusBreakdown: Record<string, number> = {};
  const skipReasons: Record<string, number> = {};
  const categoryDistribution: Record<string, number> = {};
  let estimatedAccepted = 0;
  let estimatedSkipped = 0;

  for (const doc of docs) {
    const alignment = getAlignmentFromDoc(doc);
    for (const ann of doc.annotations ?? []) {
      annotationsTotal += 1;
      const a = ann as IimlAnnotation & { category?: string; motif?: string };

      // 字段统计
      if (!a.category) missingCategoryCount += 1;
      if (a.category && NARRATIVE_CATEGORIES.has(a.category) && !(a.motif && a.motif.trim())) {
        missingMotifInNarrativeCount += 1;
      }
      const frame = ann.frame ?? "model";
      if (frame === "model" && !alignment && !isEquivalentOrthophotoResource(ann.resourceId, doc)) {
        frameModelNoAlignmentCount += 1;
      }
      const rs = ann.reviewStatus ?? "(undefined)";
      reviewStatusBreakdown[rs] = (reviewStatusBreakdown[rs] ?? 0) + 1;

      // 训练池模拟：跑 validate 看会不会通过
      const result = validateAnnotationForTraining(ann, doc);
      if (result.ready) {
        estimatedAccepted += 1;
        if (a.category) {
          categoryDistribution[a.category] = (categoryDistribution[a.category] ?? 0) + 1;
        }
      } else {
        estimatedSkipped += 1;
        for (const e of result.errors) skipReasons[e] = (skipReasons[e] ?? 0) + 1;
      }
    }
  }

  // 取 skipReasons 前 5
  const skipReasonTop = Object.entries(skipReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  // SOP §1.1 13 类 + unknown，逐类比 CATEGORY_MIN_SAMPLES
  const allCategories = [
    "figure-deity",
    "figure-immortal",
    "figure-mythic-ruler",
    "figure-loyal-assassin",
    "figure-filial-son",
    "figure-virtuous-woman",
    "figure-music-dance",
    "chariot-procession",
    "mythic-creature",
    "celestial",
    "daily-life-scene",
    "architecture",
    "inscription",
    "pattern-border"
  ];
  const underrepresentedCategories = allCategories.filter(
    (c) => (categoryDistribution[c] ?? 0) < CATEGORY_MIN_SAMPLES
  );

  return {
    generatedAt,
    catalog: {
      overrideSourcePath: catalog.health.overrideSourcePath,
      totalStones: catalog.stones.length,
      stonesWithModel: catalog.stones.filter((s) => s.hasModel).length,
      stonesWithMetadata: catalog.stones.filter((s) => s.hasMetadata).length,
      orphanModelCount: catalog.health.orphanModels.length,
      unmatchedMetadataCount: catalog.health.unmatchedMetadata.length,
      numericKeyConflictCount: catalog.health.numericKeyConflicts.length,
      unrecognizedRuleCount: catalog.health.unrecognizedRules.length,
      numericKeyConflicts: catalog.health.numericKeyConflicts,
      orphanModels: catalog.health.orphanModels,
      unmatchedMetadata: catalog.health.unmatchedMetadata
    },
    pic: {
      picDir: picHealth.picDir,
      exists: picHealth.exists,
      totalFiles: picHealth.totalFiles,
      matchedCount: matched.length,
      matched,
      unmatchedStones,
      duplicateKeys: picHealth.duplicateKeys,
      unrecognizedFiles: picHealth.unrecognizedFiles
    },
    iiml: {
      totalDocs: docs.length,
      annotationsTotal,
      missingCategoryCount,
      missingMotifInNarrativeCount,
      frameModelNoAlignmentCount,
      reviewStatusBreakdown
    },
    trainingReadiness: {
      estimatedAccepted,
      estimatedSkipped,
      skipReasonTop,
      categoryDistribution,
      underrepresentedCategories
    }
  };
}
