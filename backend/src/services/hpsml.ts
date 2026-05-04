/**
 * .hpsml 研究包解包 / 导入服务（v0.8.0）
 *
 * 把前端 `exportToHpsml` 导出的研究包（IIML + 拼接方案 + 词表 + 关系网络
 * 快照）解开后写回本机磁盘，让"两台机器之间复现一份完整研究状态"成为
 * 一键操作。
 *
 * .hpsml 包格式（formatVersion `0.1.0`）：
 * ```json
 * {
 *   "format": "hpsml",
 *   "formatVersion": "0.1.0",
 *   "package": { "exportedAt", "exporter", "notes", "generatorRunId" },
 *   "iiml": { ...完整 IimlDocument },
 *   "context": {
 *     "stone": { "id", "displayName" },
 *     "metadata": { ...结构化档案快照 },
 *     "relatedAssemblyPlans": [ ...关联拼接方案 ],
 *     "vocabulary": { ...受控词表快照 },
 *     "networkStats": { ...关系网络度量 }
 *   }
 * }
 * ```
 *
 * 导入流程（最小可用版）：
 * 1. 校验 `format` + `formatVersion`（不同版本告警继续尝试，硬错误才拒绝）
 * 2. 解 stoneId 优先级：`options.stoneId` > `context.stone.id` >
 *    `iiml.documentId` 的前缀（`{stoneId}:iiml`）
 * 3. 把 `iiml` 字段直接 `saveIimlDoc`（完整 ajv 校验后落盘
 *    `data/iiml/{stoneId}.iiml.json`）
 * 4. `relatedAssemblyPlans` 写进 `data/assembly-plans/`；id 冲突时生成新 id +
 *    `importedFromHpsml: true` 标记
 * 5. 返回 summary：导入 / 跳过 / 警告分项计数
 *
 * 冲突策略（`options.conflictStrategy`）：
 * - `"overwrite"`（默认）：直接覆盖本机已有
 * - `"skip"`：若本机已存在则跳过 IIML 部分
 *
 * **三方合并**（既不覆盖也不跳过，而是逐字段 diff 后让用户决定）当前未实装，
 * 留给 v0.9.0 的 import/merge 流程。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogConfig, getCatalog } from "./catalog.js";
import { saveIimlDoc, type IimlDocument } from "./iiml.js";

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
