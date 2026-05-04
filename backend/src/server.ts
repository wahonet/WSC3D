import cors from "cors";
import express from "express";
import morgan from "morgan";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCatalog, type CatalogConfig } from "./services/catalog.js";
import { getIimlContext, importMarkdownIntoIiml, listAlignments, loadIimlDoc, loadVocabulary, saveIimlDoc } from "./services/iiml.js";

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
// 画像石自生成 / 用户上传的资源（PNG / JPG / TIFF 等）落盘目录
// 按 stoneId 建子目录：data/stone-resources/{stoneId}/{resourceId}.{ext}
// 当前 v0.7.0 只写入"从三维模型生成的正射图"一种，未来用户上传拓片 / RTI
// 等也放这里
const stoneResourceDir = path.join(projectRoot, "data", "stone-resources");
const port = Number(process.env.PORT ?? 3100);
const app = express();

type AssemblyPlanTransform = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
};

type AssemblyPlanDimensions = {
  width: number;
  length: number;
  thickness: number;
  longEdge: number;
  unit: "cm" | "model";
  source: "metadata" | "model";
};

type AssemblyPlanItem = {
  instanceId: string;
  stoneId: string;
  displayName: string;
  locked: boolean;
  transform: AssemblyPlanTransform;
  baseDimensions?: AssemblyPlanDimensions;
};

type AssemblyPlanRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  items: AssemblyPlanItem[];
};

app.use(cors());
// 正射图生成后会以 base64 / raw blob POST 上来，放到 25MB 留一点余量
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
// 画像石资源静态托管（正射 / 用户上传的拓片等），按 stoneId 分目录
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

app.get("/api/scan", async (_req, res, next) => {
  try {
    const catalog = await getCatalog(config);
    res.json(catalog.summary);
  } catch (error) {
    next(error);
  }
});

app.post("/api/scan/refresh", async (_req, res, next) => {
  try {
    const catalog = await getCatalog(config, true);
    res.json(catalog.summary);
  } catch (error) {
    next(error);
  }
});

app.get("/api/stones", async (_req, res, next) => {
  try {
    const catalog = await getCatalog(config);
    res.json({
      generatedAt: catalog.generatedAt,
      summary: catalog.summary,
      stones: catalog.stones.map(({ model, thumbnail, metadata, ...stone }) => ({
        ...stone,
        model: model ? { fileName: model.fileName, size: model.size, extension: model.extension } : undefined,
        thumbnail: thumbnail ? { fileName: thumbnail.fileName, size: thumbnail.size, extension: thumbnail.extension } : undefined,
        metadata: metadata
          ? {
              stone_id: metadata.stone_id,
              name: metadata.name,
              dimensions: metadata.dimensions,
              dimension_note: metadata.dimension_note,
              layerCount: metadata.layers.length,
              source_file: metadata.source_file
            }
          : undefined
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/stones/:id/metadata", async (req, res, next) => {
  try {
    const catalog = await getCatalog(config);
    const stone = catalog.stones.find((item) => item.id === req.params.id);
    if (!stone?.metadata) {
      res.status(404).json({ error: "metadata_not_found" });
      return;
    }
    res.json(stone.metadata);
  } catch (error) {
    next(error);
  }
});

app.get("/api/stones/:id/model", async (req, res, next) => {
  try {
    const catalog = await getCatalog(config);
    const stone = catalog.stones.find((item) => item.id === req.params.id);
    if (!stone?.model) {
      res.status(404).json({ error: "model_not_found" });
      return;
    }
    res.sendFile(stone.model.path);
  } catch (error) {
    next(error);
  }
});

// v0.7.0：画像石资源（正射 / 拓片 / 法线图等用户生成或上传的图像）列表
// 返回这块石头下 data/stone-resources/{stoneId}/ 里的全部文件清单，让前端知道
// 有哪些已经落盘的资源。
app.get("/api/stones/:id/resources", async (req, res, next) => {
  try {
    const stoneId = req.params.id;
    const dir = path.join(stoneResourceDir, stoneId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ stoneId, resources: [] });
        return;
      }
      throw error;
    }
    const resources = entries
      .filter((name) => /\.(png|jpe?g|tiff?|webp|bmp)$/i.test(name))
      .map((fileName) => {
        // 约定文件名格式：{type}-{timestamp}.{ext}，前端存储时按这个命名
        // 旧文件无前缀也兼容显示
        const withoutExt = fileName.replace(/\.[^.]+$/u, "");
        const match = withoutExt.match(/^([a-zA-Z0-9]+)-/);
        const type = match ? match[1] : "other";
        return {
          fileName,
          type,
          uri: `/assets/stone-resources/${encodeURIComponent(stoneId)}/${encodeURIComponent(fileName)}`
        };
      });
    res.json({ stoneId, resources });
  } catch (error) {
    next(error);
  }
});

// v0.7.0：上传画像石资源图片（前端生成的正射 / 用户上传的拓片 / 法线图 等）。
// Body 支持两种格式：
//   - Content-Type: image/png → 原始二进制（express.raw 已解码）
//   - Content-Type: application/json → { type, imageBase64 } 形式
// 返回 { fileName, type, uri, size }，前端据此在 IIML resources[] 加一条。
app.post("/api/stones/:id/resources", async (req, res, next) => {
  try {
    const stoneId = req.params.id;
    const safeStoneId = stoneId.replace(/[^a-zA-Z0-9_.-]/gu, "_");
    if (!safeStoneId) {
      res.status(400).json({ error: "invalid_stone_id" });
      return;
    }

    const rawType = typeof req.query.type === "string"
      ? req.query.type
      : typeof (req.body as { type?: unknown })?.type === "string"
      ? (req.body as { type: string }).type
      : "ortho";
    const type = rawType.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 32) || "ortho";

    let buffer: Buffer | null = null;
    if (Buffer.isBuffer(req.body)) {
      buffer = req.body;
    } else if (typeof (req.body as { imageBase64?: unknown })?.imageBase64 === "string") {
      const b64 = (req.body as { imageBase64: string }).imageBase64;
      const payload = b64.startsWith("data:")
        ? b64.slice(b64.indexOf(",") + 1)
        : b64;
      buffer = Buffer.from(payload, "base64");
    }

    if (!buffer || buffer.length === 0) {
      res.status(400).json({
        error: "empty_body",
        hint: "POST PNG as raw body (Content-Type: image/png) or JSON { type, imageBase64 }"
      });
      return;
    }
    if (buffer.length > 25 * 1024 * 1024) {
      res.status(413).json({ error: "payload_too_large", maxBytes: 25 * 1024 * 1024 });
      return;
    }

    const dir = path.join(stoneResourceDir, safeStoneId);
    await mkdir(dir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const fileName = `${type}-${timestamp}.png`;
    const filePath = path.join(dir, fileName);
    await writeFile(filePath, buffer);

    res.json({
      stoneId: safeStoneId,
      type,
      fileName,
      size: buffer.length,
      uri: `/assets/stone-resources/${encodeURIComponent(safeStoneId)}/${encodeURIComponent(fileName)}`,
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/reference-images", async (_req, res, next) => {
  try {
    const catalog = await getCatalog(config);
    res.json(
      catalog.referenceImages.map((image) => ({
        fileName: image.fileName,
        size: image.size,
        url: `/assets/reference/${encodeURIComponent(image.fileName)}`
      }))
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/terms", async (_req, res, next) => {
  try {
    res.json(await loadVocabulary(projectRoot));
  } catch (error) {
    next(error);
  }
});

app.get("/api/iiml/context", (_req, res) => {
  res.json(getIimlContext());
});

app.get("/api/iiml/alignments", async (_req, res, next) => {
  try {
    res.json(await listAlignments(projectRoot));
  } catch (error) {
    next(error);
  }
});

app.get("/api/iiml/:stoneId", async (req, res, next) => {
  try {
    res.json(await loadIimlDoc(projectRoot, config, getCatalog, req.params.stoneId));
  } catch (error) {
    next(error);
  }
});

app.put("/api/iiml/:stoneId", async (req, res, next) => {
  try {
    res.json(await saveIimlDoc(projectRoot, req.params.stoneId, req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/iiml/:stoneId/import-md", async (req, res, next) => {
  try {
    res.json(await importMarkdownIntoIiml(projectRoot, config, getCatalog, req.params.stoneId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/assembly-plans", async (_req, res, next) => {
  try {
    const plans = await readAssemblyPlans();
    res.json(plans);
  } catch (error) {
    next(error);
  }
});

app.get("/api/assembly-plans/:id", async (req, res, next) => {
  try {
    const plan = await readAssemblyPlan(req.params.id);
    if (!plan) {
      res.status(404).json({ error: "assembly_plan_not_found" });
      return;
    }
    res.json(plan);
  } catch (error) {
    next(error);
  }
});

app.post("/api/assembly-plans", async (req, res, next) => {
  try {
    const plan = await saveAssemblyPlan(req.body);
    res.status(201).json(plan);
  } catch (error) {
    next(error);
  }
});

async function readAssemblyPlans(): Promise<AssemblyPlanRecord[]> {
  await mkdir(assemblyPlanDir, { recursive: true });
  const files = await readdir(assemblyPlanDir, { withFileTypes: true });
  const plans = await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => readAssemblyPlan(entry.name.replace(/\.json$/u, "")))
  );
  return plans
    .filter((plan): plan is AssemblyPlanRecord => Boolean(plan))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readAssemblyPlan(id: string): Promise<AssemblyPlanRecord | undefined> {
  const safeId = sanitizePlanId(id);
  if (!safeId) {
    return undefined;
  }
  try {
    const raw = await readFile(path.join(assemblyPlanDir, `${safeId}.json`), "utf8");
    return JSON.parse(raw) as AssemblyPlanRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function saveAssemblyPlan(body: unknown): Promise<AssemblyPlanRecord> {
  const payload = normalizeAssemblyPlanPayload(body);
  await mkdir(assemblyPlanDir, { recursive: true });

  const existing = payload.id ? await readAssemblyPlan(payload.id) : undefined;
  const id = existing?.id ?? payload.id ?? createPlanId(payload.name);
  const now = new Date().toISOString();
  const plan: AssemblyPlanRecord = {
    id,
    name: payload.name,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    itemCount: payload.items.length,
    items: payload.items
  };

  await writeFile(path.join(assemblyPlanDir, `${id}.json`), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

function normalizeAssemblyPlanPayload(body: unknown): { id?: string; name: string; items: AssemblyPlanItem[] } {
  const value = body as { id?: unknown; name?: unknown; items?: unknown };
  const name = typeof value?.name === "string" && value.name.trim() ? value.name.trim() : "未命名拼接方案";
  const id = typeof value?.id === "string" ? sanitizePlanId(value.id) : undefined;
  const rawItems = Array.isArray(value?.items) ? value.items : [];
  const items = rawItems.map(normalizeAssemblyPlanItem).filter((item): item is AssemblyPlanItem => Boolean(item));
  return { id, name, items };
}

function normalizeAssemblyPlanItem(value: unknown): AssemblyPlanItem | undefined {
  const item = value as Partial<AssemblyPlanItem>;
  if (typeof item.instanceId !== "string" || typeof item.stoneId !== "string") {
    return undefined;
  }

  const transform = normalizeTransform(item.transform);
  if (!transform) {
    return undefined;
  }

  return {
    instanceId: item.instanceId,
    stoneId: item.stoneId,
    displayName: typeof item.displayName === "string" ? item.displayName : item.stoneId,
    locked: Boolean(item.locked),
    transform,
    baseDimensions: normalizeDimensions(item.baseDimensions)
  };
}

function normalizeTransform(value: unknown): AssemblyPlanTransform | undefined {
  const transform = value as Partial<AssemblyPlanTransform>;
  if (!Array.isArray(transform?.position) || transform.position.length !== 3) {
    return undefined;
  }
  if (!Array.isArray(transform?.quaternion) || transform.quaternion.length !== 4) {
    return undefined;
  }
  const position = transform.position.map(Number) as [number, number, number];
  const quaternion = transform.quaternion.map(Number) as [number, number, number, number];
  if ([...position, ...quaternion].some((number) => !Number.isFinite(number))) {
    return undefined;
  }
  const scale = Number(transform.scale ?? 1);
  return {
    position,
    quaternion,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1
  };
}

function normalizeDimensions(value: unknown): AssemblyPlanDimensions | undefined {
  const dimensions = value as Partial<AssemblyPlanDimensions>;
  const width = Number(dimensions?.width);
  const length = Number(dimensions?.length);
  const thickness = Number(dimensions?.thickness);
  const longEdge = Number(dimensions?.longEdge);
  if ([width, length, thickness, longEdge].some((number) => !Number.isFinite(number) || number <= 0)) {
    return undefined;
  }
  return {
    width,
    length,
    thickness,
    longEdge,
    unit: dimensions.unit === "model" ? "model" : "cm",
    source: dimensions.source === "model" ? "model" : "metadata"
  };
}

function createPlanId(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40);
  return `${Date.now()}-${slug || "assembly-plan"}`;
}

function sanitizePlanId(id: string) {
  const trimmed = id.trim();
  return /^[\p{Letter}\p{Number}._-]+$/u.test(trimmed) ? trimmed : undefined;
}

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
