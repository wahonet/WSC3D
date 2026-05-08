/**
 * pic/ 高清原图目录扫描与 stoneId 配对（v0.8.x：双面 / 多面石头支持）
 *
 * 全局规约：
 * - 目录默认 `<projectRoot>/pic`，可用 `WSC3D_PIC_DIR` 环境变量覆盖
 *   （与 ai-service `_PIC_DIR` 保持一致）
 * - 文件名以"数字前缀 + 可选 face 后缀"开头：
 *   - 主面：`{N}{name}{ext}`（如 `29...画像石.tif`，face=undefined）
 *   - 副面：`{N}-{F}{name}{ext}`（如 `16-B...画像石.tif`，face="B"，用于双面石头）
 * - stoneId 形态多样（`01`、`asset-29`、`stone-29-east`），用第一个连续数字串去前导 0 取 key
 *
 * 与 ai-service 的关系：
 * - 这里的扫描逻辑与 `ai-service/app/sam.py::_find_source_image` 在算法上对齐，
 *   重复实现是因为 backend 不应依赖 ai-service 在线（IIML 文档创建走 backend）
 * - 真正给前端 `<img>` 用的转码 PNG 仍由 ai-service 提供（tif 浏览器不可读）
 *
 * 设计要点：
 * - **同 numericKey 多 face** 视为同一块 stone 的多张图（双面石头），不计入
 *   duplicateKeys；只有同 (numericKey, face) 多文件才报 duplicate
 * - `findPicForStone(stoneId, face?)` 默认取主面（face=undefined）；副面通过参数取
 * - 不缓存：每次调用现扫，pic/ 用户随时可能添加新图。目录就 < 100 文件，扫描 < 5ms
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTS = new Set([".tif", ".tiff", ".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

export type PicEntry = {
  fileName: string;
  path: string;
  numericKey: string;
  /** 面标识：undefined = 主面（无后缀），"B"/"C"… = 副面 */
  face?: string;
  size: number;
};

export type PicHealth = {
  picDir: string;
  exists: boolean;
  totalFiles: number;
  byNumericKey: Record<string, PicEntry[]>;
  /**
   * 真冲突：同 (numericKey, face) 多文件。同 numericKey 不同 face（双面石头）
   * 不算冲突。
   */
  duplicateKeys: Array<{ key: string; fileNames: string[] }>;
  unrecognizedFiles: string[];
};

export function getPicDir(projectRoot: string): string {
  return process.env.WSC3D_PIC_DIR
    ? path.resolve(process.env.WSC3D_PIC_DIR)
    : path.join(projectRoot, "pic");
}

/**
 * 把 stoneId 抽成数字 key（与 ai-service 算法对齐）。
 * "01" → "1"、"asset-29" → "29"、"stone-7-east" → "7"。
 * 没数字返回 undefined，调用方按"无配对"处理。
 */
export function stoneIdToNumericKey(stoneId: string): string | undefined {
  const m = stoneId.match(/(\d+)/);
  if (!m) return undefined;
  return m[1].replace(/^0+/, "") || "0";
}

/**
 * 抽 fileName 的 (numericKey, face)：
 * - `29武氏祠.tif` → { key: "29", face: undefined }
 * - `16-B武氏祠.tif` → { key: "16", face: "B" }
 * - `01.tif` → { key: "1", face: undefined }
 * 没有数字前缀返回 undefined。
 */
function fileNumericFace(fileName: string): { key: string; face?: string } | undefined {
  const m = fileName.match(/^(\d+)(?:-([A-Z]))?/);
  if (!m) return undefined;
  return {
    key: m[1].replace(/^0+/, "") || "0",
    face: m[2] || undefined
  };
}

export async function scanPicDir(picDir: string): Promise<PicHealth> {
  let entries: string[];
  try {
    entries = await readdir(picDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        picDir,
        exists: false,
        totalFiles: 0,
        byNumericKey: {},
        duplicateKeys: [],
        unrecognizedFiles: []
      };
    }
    throw error;
  }

  const byNumericKey: Record<string, PicEntry[]> = {};
  const unrecognizedFiles: string[] = [];

  for (const fileName of entries.sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }))) {
    const ext = path.extname(fileName).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) continue;
    const fullPath = path.join(picDir, fileName);
    let st;
    try {
      st = await stat(fullPath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const parsed = fileNumericFace(fileName);
    if (!parsed) {
      unrecognizedFiles.push(fileName);
      continue;
    }
    const entry: PicEntry = {
      fileName,
      path: fullPath,
      numericKey: parsed.key,
      face: parsed.face,
      size: st.size
    };
    if (!byNumericKey[parsed.key]) byNumericKey[parsed.key] = [];
    byNumericKey[parsed.key].push(entry);
  }

  // 真冲突：只在同 (numericKey, face) 多文件时报告。同 numericKey 不同 face
  // 视为双面石头多张图，是合法状态。
  const duplicateKeys: Array<{ key: string; fileNames: string[] }> = [];
  for (const [key, list] of Object.entries(byNumericKey)) {
    const byFace = new Map<string, string[]>();
    for (const e of list) {
      const f = e.face ?? "";
      const arr = byFace.get(f) ?? [];
      arr.push(e.fileName);
      byFace.set(f, arr);
    }
    for (const [, fileNames] of byFace) {
      if (fileNames.length > 1) duplicateKeys.push({ key, fileNames });
    }
  }

  const totalFiles = Object.values(byNumericKey).reduce((acc, list) => acc + list.length, 0);

  return {
    picDir,
    exists: true,
    totalFiles,
    byNumericKey,
    duplicateKeys,
    unrecognizedFiles
  };
}

/**
 * 根据 stoneId + 可选 face 找 pic 高清图。
 * - face 缺省：取主面（face=undefined）；若主面不存在，fallback 到字典序首个
 * - face 指定（"B"/"C"…）：精确匹配该副面
 * 同 (key, face) 多文件时取字典序首个（与 scan 排序一致）保证确定性。
 */
export async function findPicForStone(
  picDir: string,
  stoneId: string,
  face?: string
): Promise<PicEntry | undefined> {
  const key = stoneIdToNumericKey(stoneId);
  if (!key) return undefined;
  const health = await scanPicDir(picDir);
  if (!health.exists) return undefined;
  const list = health.byNumericKey[key];
  if (!list || list.length === 0) return undefined;
  const wantedFace = face?.toUpperCase();
  if (wantedFace) {
    return list.find((e) => e.face === wantedFace);
  }
  // 主面优先；没有主面（数据异常）则 fallback 到列表首个，保持向后兼容
  return list.find((e) => !e.face) ?? list[0];
}
