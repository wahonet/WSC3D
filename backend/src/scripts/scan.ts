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
