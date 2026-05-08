/**
 * PIC 面标识的前端共享工具。
 *
 * 后端将 A 面规整为 undefined / ""，副面使用 B-Z 单字母；UI 统一通过这里展示，
 * 避免 binding 与 annotation 工作区各自维护一份文案逻辑。
 */

export const DEFAULT_FACE = "";

export function formatFaceLabel(face: string | null | undefined): string {
  return face ? `${face.toUpperCase()} 面` : "A 面";
}

export function normalizeFaceForUi(face: string | null | undefined): string {
  const trimmed = face?.trim().toUpperCase() ?? "";
  return trimmed === "A" ? DEFAULT_FACE : trimmed;
}
