/**
 * 一次性目录扫描脚本
 *
 * 对外命令：`npm run scan`
 *
 * 在不启动后端 HTTP 服务的情况下扫描一遍仓库，输出 catalog summary 和已索引
 * 的画像石数量，主要用途：
 * - **首次环境检查**：把仓库 clone 下来后想确认目录里资源的关联情况是否正确
 * - **CI / 自动化**：把扫描结果重定向到日志，发现匹配失败的画像石
 *
 * 复用 `getCatalog` 的同一份逻辑，`force = true` 强制重建缓存。
 */

import path from "node:path";
import { getCatalog } from "../services/catalog.js";

const rootDir = process.env.WSC3D_ROOT ? path.resolve(process.env.WSC3D_ROOT) : process.cwd();
const catalog = await getCatalog(
  {
    rootDir,
    modelDir: process.env.WSC3D_MODEL_DIR ?? path.join(rootDir, "temp"),
    metadataDir: process.env.WSC3D_METADATA_DIR ?? path.join(rootDir, "画像石结构化分档"),
    referenceDir: process.env.WSC3D_REFERENCE_DIR ?? path.join(rootDir, "参考图")
  },
  true
);

console.log(JSON.stringify(catalog.summary, null, 2));
console.log(`Indexed stones: ${catalog.stones.length}`);
console.log(`With metadata: ${catalog.stones.filter((stone) => stone.hasMetadata).length}`);
console.log(`With model: ${catalog.stones.filter((stone) => stone.hasModel).length}`);
