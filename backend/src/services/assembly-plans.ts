import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type AssemblyPlanTransform = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
};

export type AssemblyPlanDimensions = {
  width: number;
  length: number;
  thickness: number;
  longEdge: number;
  unit: "cm" | "model";
  source: "metadata" | "model";
};

export type AssemblyPlanItem = {
  instanceId: string;
  stoneId: string;
  displayName: string;
  locked: boolean;
  transform: AssemblyPlanTransform;
  baseDimensions?: AssemblyPlanDimensions;
};

export type AssemblyPlanRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  items: AssemblyPlanItem[];
};

export async function listAssemblyPlans(assemblyPlanDir: string): Promise<AssemblyPlanRecord[]> {
  await mkdir(assemblyPlanDir, { recursive: true });
  const files = await readdir(assemblyPlanDir, { withFileTypes: true });
  const plans = await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => readAssemblyPlan(assemblyPlanDir, entry.name.replace(/\.json$/u, "")))
  );
  return plans
    .filter((plan): plan is AssemblyPlanRecord => Boolean(plan))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readAssemblyPlan(
  assemblyPlanDir: string,
  id: string
): Promise<AssemblyPlanRecord | undefined> {
  const safeId = sanitizePlanId(id);
  if (!safeId) return undefined;
  try {
    const raw = await readFile(path.join(assemblyPlanDir, `${safeId}.json`), "utf8");
    return JSON.parse(raw) as AssemblyPlanRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveAssemblyPlan(
  assemblyPlanDir: string,
  body: unknown
): Promise<AssemblyPlanRecord> {
  const payload = normalizeAssemblyPlanPayload(body);
  await mkdir(assemblyPlanDir, { recursive: true });

  const existing = payload.id ? await readAssemblyPlan(assemblyPlanDir, payload.id) : undefined;
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
  if (typeof item.instanceId !== "string" || typeof item.stoneId !== "string") return undefined;

  const transform = normalizeTransform(item.transform);
  if (!transform) return undefined;

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
  if (!Array.isArray(transform?.position) || transform.position.length !== 3) return undefined;
  if (!Array.isArray(transform?.quaternion) || transform.quaternion.length !== 4) return undefined;
  const position = transform.position.map(Number) as [number, number, number];
  const quaternion = transform.quaternion.map(Number) as [number, number, number, number];
  if ([...position, ...quaternion].some((number) => !Number.isFinite(number))) return undefined;
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
