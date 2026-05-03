import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 迁移脚本：给历史 IIML 文档里所有 annotation 补上 frame="model"。
 *
 * 背景：v0.3.0 引入了双坐标系标注（model / image）。frame 字段缺省视作 "model"，
 * 渲染层向后兼容，但保存时如果不带 frame，跨 frame 显示逻辑只能依赖 runtime 默认值。
 * 一次性把磁盘里的旧文档统一补齐，让 IIML 文件本身就完整。
 *
 * 行为：
 *   - 扫描 data/iiml/*.iiml.json
 *   - 对每个文档遍历 annotations[]：缺 frame 字段则补 "model"，已有则保留原值
 *   - 仅在该文档真正发生变化时才回写文件，保留原有 JSON 缩进（2 空格 + 末尾换行）
 *   - 输出迁移报告：扫了多少文档 / 多少标注 / 补了多少 / 写回多少文件
 *
 * 用法：`npm run migrate:iiml-frame`
 *
 * 幂等：再次运行不会再写文件（所有 annotation 已有 frame）。
 */

const projectRoot = process.env.WSC3D_ROOT
  ? path.resolve(process.env.WSC3D_ROOT)
  : process.cwd();
const iimlDir = process.env.WSC3D_IIML_DIR ?? path.join(projectRoot, "data", "iiml");

type IimlAnnotation = {
  id?: string;
  frame?: "image" | "model";
  [key: string]: unknown;
};

type IimlDocument = {
  annotations?: IimlAnnotation[];
  [key: string]: unknown;
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

  let scannedDocs = 0;
  let scannedAnnotations = 0;
  let migratedAnnotations = 0;
  let writtenDocs = 0;

  for (const entry of entries) {
    if (!entry.endsWith(".iiml.json")) {
      continue;
    }
    const filePath = path.join(iimlDir, entry);
    scannedDocs += 1;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      console.error(`  读取失败：${entry} → ${(error as Error).message}`);
      continue;
    }
    let doc: IimlDocument;
    try {
      doc = JSON.parse(raw) as IimlDocument;
    } catch (error) {
      console.error(`  JSON 解析失败：${entry} → ${(error as Error).message}`);
      continue;
    }

    const annotations = Array.isArray(doc.annotations) ? doc.annotations : [];
    let changed = 0;
    for (const annotation of annotations) {
      scannedAnnotations += 1;
      if (annotation.frame === undefined || annotation.frame === null) {
        annotation.frame = "model";
        changed += 1;
        migratedAnnotations += 1;
      }
    }

    if (changed > 0) {
      const next = `${JSON.stringify(doc, null, 2)}\n`;
      await writeFile(filePath, next, "utf8");
      writtenDocs += 1;
      console.log(`  迁移：${entry}  +${changed} 条 frame=model`);
    }
  }

  console.log("");
  console.log("汇总：");
  console.log(`  IIML 文档：${scannedDocs} 个`);
  console.log(`  扫描到的 annotation：${scannedAnnotations} 条`);
  console.log(`  补 frame=model：${migratedAnnotations} 条`);
  console.log(`  实际写回：${writtenDocs} 个文件`);
  if (migratedAnnotations === 0) {
    console.log("  全部已带 frame 字段，无需迁移。");
  }
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
