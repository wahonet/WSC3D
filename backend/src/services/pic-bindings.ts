/**
 * 高清图 ↔ 石头手动关联（v0.8.x：双面 / 多面石头支持）
 *
 * 用户从相机 / 扫描设备拖进 pic/ 的图通常是命名 `08A0001.tif` 这种（与 stone 编号
 * 无关），无法被 `pic.ts::fileNumericKey` 命中匹配。该模块提供一套显式 bind /
 * unbind 流程：
 *
 *   1. 用户在 UI 选一块 stone + 一张 pic 文件 + 可选 face 标识（A/B/C…）
 *   2. backend 把文件**重命名**为：
 *      - 主面（face 缺省）：`{N}{cleanName}{ext}`，向后兼容，且与 ai-service
 *        `_find_source_image` 数字前缀算法对齐
 *      - 副面（face = "B"/"C"…）：`{N}-{face}{cleanName}{ext}`
 *   3. `{ stoneId, face?, originalFileName, currentFileName }` 写到
 *      `data/pic-bindings.json`，主键 = (stoneId, face ?? "")
 *
 * 双面 / 多面（如武氏祠 16、17 号石）说明：
 * - 一块 stone 可绑多张图，每张占一个 face slot
 * - 默认 face = undefined（主面，无文件名后缀）
 * - 第二张及以后传 face = "B"/"C"…，文件名带 `-{face}` 后缀
 * - ai-service `_find_source_image` 默认取主面；副面通过 `face` query 参数获取
 *
 * 设计约束：
 * - **重命名前先扫 pic/**：同 (numericKey, face) 已被其他文件占用 → `target-exists`
 * - **bind 失败回滚**：fs.rename 成功但 saveBindings 失败时把文件名改回去
 * - **unbind 时若原始文件名已被占用**：追加时间戳后缀 `08A0001-1730000000.tif`
 * - **bindings.json 入仓**：团队共享 metadata；preflight / GET /api/pic/list 暴露异常
 */

import { readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";

export type PicBinding = {
  stoneId: string;
  /**
   * 面标识：undefined = 主面（文件名不带 face 后缀，向后兼容已有 27 条
   * binding）；"B" / "C"… = 副面（文件名带 `-{face}` 后缀）。
   * (stoneId, face ?? "") 构成主键。
   */
  face?: string;
  /** 用户最初拖进 pic/ 的文件名（如 08A0001.tif） */
  originalFileName: string;
  /** 重命名后的文件名（如 01武家林石.tif、16-B武氏祠某某画像石.tif） */
  currentFileName: string;
  /** 该 stone 的 displayName 快照，重命名规则的输入 */
  displayName: string;
  /** ISO 时间戳 */
  boundAt: string;
};

export type BindingsFile = {
  bindings: PicBinding[];
};

const BINDINGS_REL = path.join("data", "pic-bindings.json");

export function getBindingsPath(projectRoot: string): string {
  return path.join(projectRoot, BINDINGS_REL);
}

export async function loadBindings(projectRoot: string): Promise<PicBinding[]> {
  const fullPath = getBindingsPath(projectRoot);
  try {
    const raw = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as BindingsFile;
    return Array.isArray(parsed.bindings) ? parsed.bindings : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveBindings(projectRoot: string, bindings: PicBinding[]): Promise<void> {
  const fullPath = getBindingsPath(projectRoot);
  const payload: BindingsFile = { bindings };
  await writeFile(fullPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/**
 * 把 displayName 清洗成文件系统安全的字符串。
 * - 去掉 Windows / POSIX 都不允许的字符：< > : " / \ | ? *
 * - 去掉控制字符 + 多余空白
 * - 长度上限 80 字符（避免 Windows MAX_PATH 拦截）
 */
function cleanForFileName(displayName: string): string {
  const cleaned = displayName
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "")
    .replace(/\s+/g, "")
    .trim();
  return cleaned.slice(0, 80);
}

/**
 * 校验 face 标识：仅允许 1 个大写字母（B/C/D…）。主面用 undefined 表示，
 * 不传或传 "" / "A" 都规整为 undefined（"A" = 主面 = 不带后缀）。
 */
export function normalizeFace(face: string | null | undefined): string | undefined {
  if (face === undefined || face === null) return undefined;
  const trimmed = face.trim().toUpperCase();
  if (!trimmed || trimmed === "A") return undefined;
  if (!/^[B-Z]$/.test(trimmed)) {
    throw new Error(`invalid-face:${face}`);
  }
  return trimmed;
}

/**
 * 按 stoneId + displayName + face + 原扩展名计算"目标重命名"。
 * 与 ai-service `_find_source_image` 的 `^(\d+)` + 去前导 0 算法对齐。
 *
 * - 主面（face=undefined）：`{N}{name}{ext}` — 不带后缀，保持向后兼容
 * - 副面（face="B"/"C"…）：`{N}-{face}{name}{ext}` — `-` 分隔避免与中文 name
 *   边界混淆（中文不会出现 `-`）
 */
export function computeRenamedFileName(
  stoneId: string,
  displayName: string,
  originalFileName: string,
  face?: string
): string {
  const m = stoneId.match(/(\d+)/);
  const numericRaw = m?.[1] ?? "";
  const numericPrefix = numericRaw || "asset";
  const ext = path.extname(originalFileName).toLowerCase() || ".tif";
  const clean = cleanForFileName(displayName) || stoneId;
  const faceSuffix = face ? `-${face}` : "";
  return `${numericPrefix}${faceSuffix}${clean}${ext}`;
}

export type BindResult =
  | { ok: true; binding: PicBinding }
  | { ok: false; error: string; detail?: string };

/**
 * 把 originalFileName 重命名成"以 stone numericKey 开头"的形式，并写入 bindings。
 *
 * 主键 (stoneId, face ?? "")。同一块 stone 可以同时有主面 + 多个副面 binding。
 *
 * 失败场景：
 * - file-not-found：原文件不存在
 * - target-exists：目标文件名已被其他文件占用（且不是同一文件）
 * - numeric-key-conflict：pic/ 中已有同 (numericKey, face) 的其他文件（未通过本流程绑定）
 * - already-bound：该 (stoneId, face) 已经有 binding（先 unbind 再 bind）
 * - invalid-face：face 不是合法的 B-Z 单字母
 */
export async function bindStoneToPic(
  projectRoot: string,
  picDir: string,
  stoneId: string,
  displayName: string,
  originalFileName: string,
  face?: string
): Promise<BindResult> {
  let normalizedFace: string | undefined;
  try {
    normalizedFace = normalizeFace(face);
  } catch {
    return { ok: false, error: "invalid-face", detail: face };
  }

  const sourcePath = path.join(picDir, originalFileName);
  try {
    const st = await stat(sourcePath);
    if (!st.isFile()) return { ok: false, error: "file-not-found", detail: originalFileName };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "file-not-found", detail: originalFileName };
    }
    throw error;
  }

  const bindings = await loadBindings(projectRoot);
  if (bindings.some((b) => b.stoneId === stoneId && (b.face ?? undefined) === normalizedFace)) {
    return {
      ok: false,
      error: "already-bound",
      detail: normalizedFace ? `${stoneId}/${normalizedFace}` : stoneId
    };
  }

  const targetName = computeRenamedFileName(stoneId, displayName, originalFileName, normalizedFace);
  const targetPath = path.join(picDir, targetName);

  if (targetName !== originalFileName) {
    try {
      const targetStat = await stat(targetPath);
      if (targetStat.isFile()) {
        return { ok: false, error: "target-exists", detail: targetName };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // 同 (numericKey, face) 冲突检测：避免把 32xxx 误绑到已经存在的 32yyy 上
  const conflict = await findExistingNumericKeyConflict(picDir, stoneId, originalFileName, normalizedFace);
  if (conflict) {
    return { ok: false, error: "numeric-key-conflict", detail: conflict };
  }

  if (targetName !== originalFileName) {
    await rename(sourcePath, targetPath);
  }

  const binding: PicBinding = {
    stoneId,
    face: normalizedFace,
    originalFileName,
    currentFileName: targetName,
    displayName,
    boundAt: new Date().toISOString()
  };
  try {
    await saveBindings(projectRoot, [...bindings, binding]);
  } catch (error) {
    if (targetName !== originalFileName) {
      try {
        await rename(targetPath, sourcePath);
      } catch {
        // 回滚失败，磁盘状态已脏；让上层报错
      }
    }
    throw error;
  }
  return { ok: true, binding };
}

/**
 * 反向：把 binding 对应的文件改回原始文件名，删除 binding 记录。
 *
 * 如果原始文件名当前已被占用（可能用户又拖了同名文件进来），重命名为
 * `{stem}-{timestamp}{ext}`，并把这个最终名作为 detail 返回给前端。
 */
export type UnbindResult =
  | { ok: true; restoredFileName: string }
  | { ok: false; error: string; detail?: string };

export async function unbindStone(
  projectRoot: string,
  picDir: string,
  stoneId: string,
  face?: string
): Promise<UnbindResult> {
  let normalizedFace: string | undefined;
  try {
    normalizedFace = normalizeFace(face);
  } catch {
    return { ok: false, error: "invalid-face", detail: face };
  }
  const bindings = await loadBindings(projectRoot);
  const idx = bindings.findIndex(
    (b) => b.stoneId === stoneId && (b.face ?? undefined) === normalizedFace
  );
  if (idx < 0) {
    return {
      ok: false,
      error: "not-bound",
      detail: normalizedFace ? `${stoneId}/${normalizedFace}` : stoneId
    };
  }
  const target = bindings[idx];

  const currentPath = path.join(picDir, target.currentFileName);
  try {
    await stat(currentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 文件已不在原位置，直接删 binding 让用户重新关联
      const next = bindings.slice();
      next.splice(idx, 1);
      await saveBindings(projectRoot, next);
      return { ok: false, error: "file-missing", detail: target.currentFileName };
    }
    throw error;
  }

  // 优先用原始名；冲突则追加时间戳
  let restoredName = target.originalFileName;
  let restoredPath = path.join(picDir, restoredName);
  if (restoredName !== target.currentFileName) {
    let exists = false;
    try {
      await stat(restoredPath);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      const ext = path.extname(restoredName);
      const stem = restoredName.slice(0, restoredName.length - ext.length);
      const stamp = Math.floor(Date.now() / 1000);
      restoredName = `${stem}-${stamp}${ext}`;
      restoredPath = path.join(picDir, restoredName);
    }
    await rename(currentPath, restoredPath);
  }

  const next = bindings.slice();
  next.splice(idx, 1);
  await saveBindings(projectRoot, next);
  return { ok: true, restoredFileName: restoredName };
}

/**
 * 检测：如果按 (stoneId, face) 写入新文件，会不会与 pic/ 里已存在的、未通过本流程
 * 管控的同 (numericKey, face) 文件撞上。命中返回那个冲突文件名。
 *
 * 双面石头：同 numericKey 不同 face 不算冲突（如 16{name}.tif + 16-B{name}.tif
 * 共存）。
 */
async function findExistingNumericKeyConflict(
  picDir: string,
  stoneId: string,
  ignoreFileName: string,
  face: string | undefined
): Promise<string | undefined> {
  const m = stoneId.match(/(\d+)/);
  if (!m) return undefined;
  const expected = m[1].replace(/^0+/, "") || "0";

  const { readdir } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(picDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry === ignoreFileName) continue;
    // `^(\d+)(?:-([A-Z]))?` 同时抽 numericKey + face，face 不同不算冲突
    const mm = entry.match(/^(\d+)(?:-([A-Z]))?/);
    if (!mm) continue;
    const key = mm[1].replace(/^0+/, "") || "0";
    const entryFace = mm[2] || undefined;
    if (key === expected && entryFace === face) return entry;
  }
  return undefined;
}
