import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|tiff?|webp|bmp)$/i;

export type StoneResourceEntry = {
  fileName: string;
  type: string;
  uri: string;
};

export type UploadedStoneResource = StoneResourceEntry & {
  stoneId: string;
  size: number;
  createdAt: string;
};

export async function listStoneResources(
  stoneResourceDir: string,
  stoneId: string
): Promise<{ stoneId: string; resources: StoneResourceEntry[] }> {
  const dir = path.join(stoneResourceDir, stoneId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { stoneId, resources: [] };
    }
    throw error;
  }

  const resources = entries
    .filter((name) => IMAGE_FILE_PATTERN.test(name))
    .map((fileName) => {
      const withoutExt = fileName.replace(/\.[^.]+$/u, "");
      const match = withoutExt.match(/^([a-zA-Z0-9]+)-/);
      const type = match ? match[1] : "other";
      return {
        fileName,
        type,
        uri: `/assets/stone-resources/${encodeURIComponent(stoneId)}/${encodeURIComponent(fileName)}`
      };
    });
  return { stoneId, resources };
}

export async function uploadStoneResource(
  stoneResourceDir: string,
  stoneId: string,
  rawType: string,
  buffer: Buffer
): Promise<UploadedStoneResource> {
  const safeStoneId = sanitizeSegment(stoneId);
  if (!safeStoneId) {
    throw new ResourceInputError(400, "invalid_stone_id");
  }
  if (!buffer || buffer.length === 0) {
    throw new ResourceInputError(400, "empty_body");
  }
  if (buffer.length > 25 * 1024 * 1024) {
    throw new ResourceInputError(413, "payload_too_large", { maxBytes: 25 * 1024 * 1024 });
  }

  const type = rawType.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 32) || "ortho";
  const dir = path.join(stoneResourceDir, safeStoneId);
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const fileName = `${type}-${timestamp}.png`;
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, buffer);

  return {
    stoneId: safeStoneId,
    type,
    fileName,
    size: buffer.length,
    uri: `/assets/stone-resources/${encodeURIComponent(safeStoneId)}/${encodeURIComponent(fileName)}`,
    createdAt: new Date().toISOString()
  };
}

export async function deleteStoneResource(
  stoneResourceDir: string,
  stoneId: string,
  fileName: string
): Promise<{ ok: true; stoneId: string; fileName: string }> {
  const safeStoneId = sanitizeSegment(stoneId);
  const safeFileName = sanitizeSegment(fileName);
  if (!safeStoneId || !safeFileName || safeFileName === "." || safeFileName === "..") {
    throw new ResourceInputError(400, "invalid_params");
  }
  if (!/^ortho/iu.test(safeFileName)) {
    throw new ResourceInputError(403, "only_ortho_can_be_deleted");
  }

  const baseDir = path.join(stoneResourceDir, safeStoneId);
  const filePath = path.join(baseDir, safeFileName);
  if (!filePath.startsWith(baseDir + path.sep)) {
    throw new ResourceInputError(400, "invalid_filename");
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ResourceInputError(404, "file_not_found");
    }
    throw error;
  }
  return { ok: true, stoneId: safeStoneId, fileName: safeFileName };
}

// P2：标注外观资产（mask / cutout / thumbnail）落盘。
// 存到 data/stone-resources/{stoneId}/annotations/{annotationId}/{kind}.png，
// 走已有的 /assets/stone-resources 静态托管；同名覆盖（一条标注只保留最新一套）。
const ANNOTATION_ASSET_KINDS = ["mask", "cutout", "thumbnail"] as const;
export type AnnotationAssetKind = (typeof ANNOTATION_ASSET_KINDS)[number];

export type AnnotationAssetUris = Partial<Record<`${AnnotationAssetKind}Uri`, string>>;

export async function saveAnnotationAssets(
  stoneResourceDir: string,
  stoneId: string,
  annotationId: string,
  assets: Partial<Record<AnnotationAssetKind, string>>
): Promise<{ stoneId: string; annotationId: string; uris: AnnotationAssetUris }> {
  const safeStoneId = sanitizeSegment(stoneId);
  const safeAnnotationId = sanitizeSegment(annotationId);
  if (!safeStoneId || !safeAnnotationId) {
    throw new ResourceInputError(400, "invalid_params");
  }
  const entries = ANNOTATION_ASSET_KINDS.map((kind) => [kind, assets[kind]] as const).filter(
    (entry): entry is [AnnotationAssetKind, string] => typeof entry[1] === "string" && entry[1].length > 0
  );
  if (entries.length === 0) {
    throw new ResourceInputError(400, "no_assets");
  }

  const dir = path.join(stoneResourceDir, safeStoneId, "annotations", safeAnnotationId);
  await mkdir(dir, { recursive: true });

  const uris: AnnotationAssetUris = {};
  for (const [kind, base64] of entries) {
    const payload = base64.startsWith("data:") ? base64.slice(base64.indexOf(",") + 1) : base64;
    const buffer = Buffer.from(payload, "base64");
    if (buffer.length === 0) {
      throw new ResourceInputError(400, "empty_asset", { kind });
    }
    if (buffer.length > 30 * 1024 * 1024) {
      throw new ResourceInputError(413, "payload_too_large", { kind });
    }
    await writeFile(path.join(dir, `${kind}.png`), buffer);
    uris[`${kind}Uri`] =
      `/assets/stone-resources/${encodeURIComponent(safeStoneId)}/annotations/${encodeURIComponent(safeAnnotationId)}/${kind}.png`;
  }
  return { stoneId: safeStoneId, annotationId: safeAnnotationId, uris };
}

export class ResourceInputError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(code);
  }
}

export function bufferFromStoneResourceBody(body: unknown): Buffer | null {
  if (Buffer.isBuffer(body)) return body;
  if (typeof (body as { imageBase64?: unknown })?.imageBase64 !== "string") return null;
  const b64 = (body as { imageBase64: string }).imageBase64;
  const payload = b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
  return Buffer.from(payload, "base64");
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_");
}
