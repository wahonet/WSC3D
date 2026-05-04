import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogConfig, getCatalog } from "./catalog.js";
import { saveIimlDoc, type IimlDocument } from "./iiml.js";

// I3 v0.8.0：.hpsml 研究包解包 / 导入服务。
//
// .hpsml 格式参考前端 frontend/src/modules/annotation/exporters.ts 里的
// exportToHpsml；核心是：
//   {
//     format: "hpsml",
//     formatVersion: "0.1.0",
//     package: { exportedAt, exporter, notes, generatorRunId },
//     iiml: IimlDocument,
//     context: {
//       stone, metadata, relatedAssemblyPlans, vocabulary, networkStats
//     }
//   }
//
// 导入策略（v0.8.0 最小可用版）：
//   1. 校验 format + formatVersion
//   2. 从 iiml.documentId 或 stone 字段里反解 stoneId（没有 stoneId 时默认
//      用 options.stoneId，否则报 invalid_package）
//   3. 把 iiml 字段直接写进 data/iiml/{stoneId}.iiml.json（走 saveIimlDoc，
//      会跑完整 ajv 校验）
//   4. relatedAssemblyPlans 写进 data/assembly-plans/（若 id 冲突走 append
//      模式，给个新 id；v0.8.0 粗粒度，不做三方合并）
//   5. 返回 summary: { stoneId, importedIiml, importedPlans, skippedPlans, warnings }
//
// 跨机器场景里常见冲突（本机已有该 stoneId 的 IIML）由 options.conflictStrategy
// 控制：
//   - "overwrite"（默认）直接覆盖
//   - "skip" 若目标已存在则跳过 iiml 部分
//   - "merge" 当前未实装；想要精细三方合并请等 v0.9.0 的 import/merge 流程

export type HpsmlImportOptions = {
  // 显式指定 stoneId（覆盖包里隐含的 stoneId）；跨库导入时常用
  stoneId?: string;
  conflictStrategy?: "overwrite" | "skip";
};

export type HpsmlImportSummary = {
  stoneId: string;
  imported: {
    iiml: boolean;
    annotations: number;
    relations: number;
    processingRuns: number;
    resources: number;
    assemblyPlans: number;
  };
  skipped: {
    iiml: boolean;
    assemblyPlans: number;
  };
  warnings: string[];
};

const SUPPORTED_FORMAT_VERSION = "0.1.0";

type HpsmlPackageShape = {
  format?: unknown;
  formatVersion?: unknown;
  package?: { exportedAt?: unknown; exporter?: unknown; notes?: unknown };
  iiml?: IimlDocument;
  context?: {
    stone?: { id?: unknown; displayName?: unknown } | null;
    metadata?: unknown;
    relatedAssemblyPlans?: Array<Record<string, unknown>>;
    vocabulary?: unknown;
    networkStats?: unknown;
  };
};

export async function importHpsmlPackage(
  projectRoot: string,
  catalogConfig: CatalogConfig,
  _getCatalogImpl: typeof getCatalog,
  payload: unknown,
  options: HpsmlImportOptions = {}
): Promise<HpsmlImportSummary> {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid_hpsml_package: not_object");
  }
  const pkg = payload as HpsmlPackageShape;

  if (pkg.format !== "hpsml") {
    throw new Error(`invalid_hpsml_package: format=${String(pkg.format)}`);
  }
  if (typeof pkg.formatVersion !== "string") {
    throw new Error("invalid_hpsml_package: missing_formatVersion");
  }
  if (pkg.formatVersion !== SUPPORTED_FORMAT_VERSION) {
    // 不抛错，只告警；IimlDocument 结构向后兼容时仍能导入
    // eslint-disable-next-line no-console
    console.warn(
      `[hpsml] formatVersion=${pkg.formatVersion} != supported ${SUPPORTED_FORMAT_VERSION}，尝试兼容导入`
    );
  }

  // 1) 解 stoneId：options.stoneId > context.stone.id > iiml.documentId 的 stoneId 前缀
  const contextStoneId =
    typeof pkg.context?.stone?.id === "string" ? pkg.context.stone.id : undefined;
  const docIdStoneId = extractStoneIdFromDocumentId(pkg.iiml?.documentId);
  const stoneId = options.stoneId ?? contextStoneId ?? docIdStoneId;
  if (!stoneId) {
    throw new Error("invalid_hpsml_package: cannot_resolve_stoneId");
  }

  const warnings: string[] = [];
  const summary: HpsmlImportSummary = {
    stoneId,
    imported: {
      iiml: false,
      annotations: 0,
      relations: 0,
      processingRuns: 0,
      resources: 0,
      assemblyPlans: 0
    },
    skipped: {
      iiml: false,
      assemblyPlans: 0
    },
    warnings
  };

  // 2) 导入 IIML 主体
  if (pkg.iiml) {
    const conflict = options.conflictStrategy ?? "overwrite";
    if (conflict === "skip") {
      // 探测本机是否已有；为了不增加 I/O 依赖，直接尝试写；若失败走回退
      // 简单起见：skip 模式先读一遍
      const existing = await loadExistingSilently(projectRoot, stoneId);
      if (existing) {
        summary.skipped.iiml = true;
        warnings.push(`skip existing iiml at data/iiml/${stoneId}.iiml.json`);
      } else {
        await saveIimlDoc(projectRoot, stoneId, pkg.iiml);
        summary.imported.iiml = true;
        summary.imported.annotations = pkg.iiml.annotations?.length ?? 0;
        summary.imported.relations = pkg.iiml.relations?.length ?? 0;
        summary.imported.processingRuns = pkg.iiml.processingRuns?.length ?? 0;
        summary.imported.resources = pkg.iiml.resources?.length ?? 0;
      }
    } else {
      await saveIimlDoc(projectRoot, stoneId, pkg.iiml);
      summary.imported.iiml = true;
      summary.imported.annotations = pkg.iiml.annotations?.length ?? 0;
      summary.imported.relations = pkg.iiml.relations?.length ?? 0;
      summary.imported.processingRuns = pkg.iiml.processingRuns?.length ?? 0;
      summary.imported.resources = pkg.iiml.resources?.length ?? 0;
    }
  } else {
    warnings.push("package has no iiml body");
  }

  // 3) 导入拼接方案（暂不做冲突合并，id 冲突时重新生成）
  const plans = pkg.context?.relatedAssemblyPlans ?? [];
  if (Array.isArray(plans) && plans.length > 0) {
    const planDir = path.join(projectRoot, "data", "assembly-plans");
    await mkdir(planDir, { recursive: true });
    for (const plan of plans) {
      try {
        const originalId = typeof plan.id === "string" ? plan.id : undefined;
        const importedId = originalId
          ? `${originalId}-imported-${Date.now().toString(36)}`
          : `plan-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const record = {
          ...plan,
          id: importedId,
          importedAt: new Date().toISOString(),
          importedFromHpsml: true
        };
        const filePath = path.join(planDir, `${importedId}.json`);
        await writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
        summary.imported.assemblyPlans += 1;
      } catch (error) {
        summary.skipped.assemblyPlans += 1;
        warnings.push(`skip plan: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  void catalogConfig;
  return summary;
}

function extractStoneIdFromDocumentId(documentId: unknown): string | undefined {
  if (typeof documentId !== "string") return undefined;
  // 约定：documentId 形如 "{stoneId}:iiml"
  const idx = documentId.indexOf(":");
  if (idx > 0) return documentId.slice(0, idx);
  return documentId || undefined;
}

async function loadExistingSilently(projectRoot: string, stoneId: string): Promise<string | null> {
  try {
    const iimlPath = path.join(projectRoot, "data", "iiml", `${stoneId}.iiml.json`);
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(iimlPath, "utf-8");
    return raw;
  } catch {
    return null;
  }
}
