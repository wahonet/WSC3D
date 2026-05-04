/**
 * pic/ 高清原图目录扫描与 stoneId 配对
 *
 * 全局规约：
 * - 目录默认 `<projectRoot>/pic`，可用 `WSC3D_PIC_DIR` 环境变量覆盖
 *   （与 ai-service `_PIC_DIR` 保持一致）
 * - 文件名以数字前缀开头 → 该数字（去前导 0）作为 stoneId 配对 key
 *   （如 `29东汉武氏祠左石室后壁小龛西侧画像石.tif` → key="29"）
 * - stoneId 形态多样（`01`、`asset-29`、`stone-29-east`），用第一个连续数字串去前导 0 取 key
 *
 * 与 ai-service 的关系：
 * - 这里的扫描逻辑与 `ai-service/app/sam.py::_find_source_image` 在算法上对齐，
 *   重复实现是因为 backend 不应依赖 ai-service 在线（IIML 文档创建走 backend）
 * - 真正给前端 `<img>` 用的转码 PNG 仍由 ai-service 提供（tif 浏览器不可读）
 *
 * 设计要点：
 * - 同 numericKey 多文件 → 列入 `duplicateKeys`，让 preflight 报警，但 `findPicForStone`
 *   仍按文件名字典序选第一个保证确定性，避免 `iterdir` 顺序在不同 OS 下漂移
 * - 不缓存：每次调用现扫，pic/ 用户随时可能添加新图。目录就 < 100 文件，扫描 < 5ms
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTS = new Set([".tif", ".tiff", ".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

export type PicEntry = {
  fileName: string;
  path: string;
  numericKey: string;
  size: number;
};

export type PicHealth = {
  picDir: string;
  exists: boolean;
  totalFiles: number;
  byNumericKey: Record<string, PicEntry[]>;
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

function fileNumericKey(fileName: string): string | undefined {
  const m = fileName.match(/^(\d+)/);
  if (!m) return undefined;
  return m[1].replace(/^0+/, "") || "0";
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
    const key = fileNumericKey(fileName);
    if (!key) {
      unrecognizedFiles.push(fileName);
      continue;
    }
    const entry: PicEntry = { fileName, path: fullPath, numericKey: key, size: st.size };
    if (!byNumericKey[key]) byNumericKey[key] = [];
    byNumericKey[key].push(entry);
  }

  const duplicateKeys = Object.entries(byNumericKey)
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, fileNames: list.map((e) => e.fileName) }));

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
 * 根据 stoneId 找 pic 高清图。同 key 多文件时取字典序首个（与 scan 排序一致），
 * 保证确定性。
 */
export async function findPicForStone(picDir: string, stoneId: string): Promise<PicEntry | undefined> {
  const key = stoneIdToNumericKey(stoneId);
  if (!key) return undefined;
  const health = await scanPicDir(picDir);
  if (!health.exists) return undefined;
  const list = health.byNumericKey[key];
  return list?.[0];
}
