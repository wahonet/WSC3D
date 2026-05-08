/**
 * WSC3D 后端入口（Express，:3100）。
 *
 * 入口层只负责全局配置、中间件、静态资源和领域 router 装配；业务读写逻辑下沉到
 * `services/*`，HTTP 边界下沉到 `routes/*`。
 */

import cors from "cors";
import express from "express";
import morgan from "morgan";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssemblyRouter } from "./routes/assembly.js";
import { createCatalogRouter } from "./routes/catalog.js";
import { createIimlRouter } from "./routes/iiml.js";
import { createPicRouter } from "./routes/pic.js";
import { createResourcesRouter } from "./routes/resources.js";
import { createTrainingRouter } from "./routes/training.js";
import { getCatalog, type CatalogConfig } from "./services/catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.WSC3D_ROOT
  ? path.resolve(process.env.WSC3D_ROOT)
  : path.resolve(__dirname, "../..");

const config: CatalogConfig = {
  rootDir: projectRoot,
  modelDir: process.env.WSC3D_MODEL_DIR ?? path.join(projectRoot, "temp"),
  metadataDir: process.env.WSC3D_METADATA_DIR ?? path.join(projectRoot, "画像石结构化分档"),
  referenceDir: process.env.WSC3D_REFERENCE_DIR ?? path.join(projectRoot, "参考图")
};

const assemblyPlanDir = path.join(projectRoot, "data", "assembly-plans");
const stoneResourceDir = path.join(projectRoot, "data", "stone-resources");
const port = Number(process.env.PORT ?? 3100);
const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.raw({ type: "image/png", limit: "25mb" }));
app.use(morgan("dev"));

app.use(
  "/assets/models",
  express.static(config.modelDir, {
    etag: true,
    maxAge: "1h",
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  })
);
app.use("/assets/reference", express.static(config.referenceDir));
app.use(
  "/assets/stone-resources",
  express.static(stoneResourceDir, {
    etag: true,
    maxAge: "1h",
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }
  })
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "wsc3d-api", generatedAt: new Date().toISOString() });
});

app.use("/api", createCatalogRouter(config, getCatalog));
app.use("/api", createResourcesRouter(stoneResourceDir));
app.use("/api", createIimlRouter(projectRoot, config, getCatalog));
app.use("/api", createTrainingRouter(projectRoot, config, getCatalog));
app.use("/api", createPicRouter(projectRoot, config, getCatalog));
app.use("/api", createAssemblyRouter(assemblyPlanDir));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({
    error: "internal_server_error",
    message: error instanceof Error ? error.message : String(error)
  });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`WSC3D API listening on http://127.0.0.1:${port}`);
  console.log(`Project root: ${projectRoot}`);
});
