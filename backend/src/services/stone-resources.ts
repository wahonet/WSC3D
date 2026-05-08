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
