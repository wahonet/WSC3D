import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { enrichDocAnchors, type StoneDimensionsCm } from "../services/anchor.js";
import { getCatalog, type CatalogConfig } from "../services/catalog.js";

/**
 * P4 迁移脚本：给历史 IIML 文档里所有 annotation 派生 `anchor` 空间锚点。
 *
 * 背景：v0.9.0 确立"正射影像为唯一空间基准"的坐标原则。每条标注保存时会自动
 * 派生 anchor（canonicalFrame / bboxUv / centroidUv / 物理位置 cm），存量文档
 * 用本脚本一次性补齐，之后 PUT /api/iiml/:stoneId 会持续刷新。
 *
 * 行为：
 *   - 扫描 data/iiml/*.iiml.json
 *   - 用 catalog 里的石头实测尺寸（cm）派生 physical
 *   - 仅在 anchor 实际变化时回写（幂等：再次运行零写盘）
 *
 * 用法：`npm run migrate:iiml-anchor`
 */

const projectRoot = process.env.WSC3D_ROOT
  ? path.resolve(process.env.WSC3D_ROOT)
  : process.cwd();
const iimlDir = process.env.WSC3D_IIML_DIR ?? path.join(projectRoot, "data", "iiml");

const catalogConfig: CatalogConfig = {
  rootDir: projectRoot,
  modelDir: process.env.WSC3D_MODEL_DIR ?? path.join(projectRoot, "temp"),
  metadataDir: process.env.WSC3D_METADATA_DIR ?? path.join(projectRoot, "画像石结构化分档"),
  referenceDir: process.env.WSC3D_REFERENCE_DIR ?? path.join(projectRoot, "参考图")
};

async function migrate(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(iimlDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`目录不存在，跳过：${iimlDir}`);
      return;
    }
    throw error;
  }

  const dimensionsByStone = new Map<string, StoneDimensionsCm>();
  try {
    const catalog = await getCatalog(catalogConfig);
    for (const stone of catalog.stones) {
      if (stone.metadata?.dimensions) {
        dimensionsByStone.set(stone.id, stone.metadata.dimensions);
      }
    }
  } catch (error) {
    console.warn(`catalog 加载失败（anchor 将缺 physical）：${(error as Error).message}`);
  }

  let scannedDocs = 0;
  let changedDocs = 0;

  for (const entry of entries) {
    if (!entry.endsWith(".iiml.json")) {
      continue;
    }
    const filePath = path.join(iimlDir, entry);
    scannedDocs += 1;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      console.error(`  读取 / 解析失败：${entry} → ${(error as Error).message}`);
      continue;
    }

    const stoneId = entry.replace(/\.iiml\.json$/u, "");
    const changed = enrichDocAnchors(doc, dimensionsByStone.get(stoneId));
    if (changed) {
      await writeFile(filePath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
      changedDocs += 1;
      const count = Array.isArray(doc.annotations) ? doc.annotations.length : 0;
      console.log(`  迁移：${entry}（${count} 条标注的 anchor 已派生 / 刷新）`);
    }
  }

  console.log("");
  console.log("汇总：");
  console.log(`  IIML 文档：${scannedDocs} 个`);
  console.log(`  实际写回：${changedDocs} 个文件`);
  if (changedDocs === 0) {
    console.log("  全部 anchor 已是最新，无需迁移。");
  }
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
