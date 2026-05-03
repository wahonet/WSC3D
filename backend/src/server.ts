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
app.use(express.json({ limit: "20mb" }));
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
