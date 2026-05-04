/**
 * 标注模块本地类型定义
 *
 * 把 `frontend/src/api/client.ts` 里的 IIML 相关类型 re-export，再追加标注模块
 * 自有的视图态类型（工具、投影上下文、reducer action 等）。这样标注模块内部
 * 文件只需要 import "./types"，无需关心字段是 IIML 协议字段还是 UI 派生字段。
 *
 * 主要内容：
 * - `AnnotationTool`：当前激活的工具（select / rect / ellipse / point / pen /
 *   sam / calibrate）
 * - `ProjectionContext`：屏幕坐标 ↔ UV 投影上下文（4 角顶点 + 画布尺寸）
 * - `AnnotationState` / `AnnotationAction`：reducer 的状态机契约
 * - `IimlResourceTransform` / `IimlResourceEntry`：资源元信息扩展（与 IIML
 *   schema 对齐，由本模块持有定义）
 */

import type {
  IimlAlignment,
  IimlAlignmentControlPoint,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlDocument,
  IimlGeometry,
  IimlPoint,
  IimlProcessingRun,
  IimlRelation,
  IimlRelationKind,
  IimlRelationOrigin,
  IimlReviewStatus,
  IimlStructuralLevel,
  VocabularyTerm
} from "../../api/client";

export type AnnotationTool = "select" | "rect" | "ellipse" | "point" | "pen" | "sam" | "calibrate";

export type ProjectionContext = {
  corners: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number }
  ];
  canvasWidth: number;
  canvasHeight: number;
};

export type AnnotationState = {
  doc?: IimlDocument;
  selectedAnnotationId?: string;
  draftAnnotationId?: string;
  activeTool: AnnotationTool;
  status?: string;
  undoStack: IimlDocument[];
  redoStack: IimlDocument[];
};

// I2 v0.8.0：跨资源坐标变换。描述一个资源相对"基准资源"的变换；当前基准是
// 3D 模型（modelBox UV）。v0.9.0 会在画布上实装跨资源投影；v0.8.0 先把数据
// 模型铺好 + 正射图生成时自动填入，为将来的跨资源标注显示做准备。
export type IimlResourceTransform =
  | {
      // 正射图由 3D 模型按固定方向 + OrthographicCamera 生成；变换是纯线性
      // 仿射（modelBox UV ↔ 正射图 UV）。frustumScale = 生成时 frustum /
      // modelAABB 比例（默认 1.0 紧贴 AABB 无白边）；view="front" +
      // frustumScale===1 时 UV 与 modelBox UV 完全相等，记为 equivalentToModel
      kind: "orthographic-from-model";
      view: "front" | "back" | "top" | "bottom";
      modelAABB: { width: number; height: number; depth: number };
      pixelSize: { width: number; height: number };
      frustumScale: number;
      // 是否"与 3D 模型 modelBox UV 坐标等价"：true 时在该资源上新建的标注
      // 直接记 frame="model"，3D 视图与正射图视图自动双向共享标注，不需要
      // alignment 校准。v0.8.0 版本仅 view==="front" + frustumScale===1.0 满足
      equivalentToModel?: boolean;
      // 生成时附带的相机参数，便于未来反推与导出完整变换矩阵
      generatedAt?: string;
    }
  | {
      // 4 点单应性：与 culturalObject.alignment 同型，但绑定到"这个资源"而非
      // 绑到整个 culturalObject，便于同一块石头挂多个拓片 / 正射
      kind: "homography-4pt";
      controlPoints: Array<{ model: [number, number]; image: [number, number] }>;
      // 基准资源 id；默认 pic/ 原图
      referenceResourceId?: string;
    }
  | {
      // 显式 3x3 仿射矩阵（直接给；外部工具导入时常见）
      kind: "affine-matrix";
      matrix: number[]; // row-major 3x3
      referenceResourceId?: string;
    };

export type IimlResourceEntry = {
  id: string;
  type: string;
  uri: string;
  // G1：可选元数据。description / acquisition / acquiredBy 让多源资源可追溯
  description?: string;
  acquisition?: string;
  acquiredBy?: string;
  acquiredAt?: string;
  // I2 v0.8.0：资源相对基准资源（默认 3D 模型）的坐标变换
  transform?: IimlResourceTransform;
  // 派生标记：UI 不参与持久化，标识"哪个资源是当前 UI 默认对应的"
  // 真正持久化只看 doc.resources[]；activeResourceId 是 UI state
  [key: string]: unknown;
};

export type AnnotationAction =
  | { type: "set-doc"; doc: IimlDocument }
  | { type: "set-tool"; tool: AnnotationTool }
  | { type: "set-status"; status?: string }
  | { type: "select"; id?: string }
  | { type: "set-draft"; id?: string }
  | { type: "add-annotation"; annotation: IimlAnnotation; asDraft?: boolean }
  | { type: "update-annotation"; id: string; patch: Partial<IimlAnnotation> }
  | { type: "delete-annotation"; id: string }
  | { type: "set-alignment"; alignment: IimlAlignment | undefined }
  | { type: "add-relation"; relation: IimlRelation }
  | { type: "update-relation"; id: string; patch: Partial<IimlRelation> }
  | { type: "delete-relation"; id: string }
  | { type: "add-processing-run"; run: IimlProcessingRun }
  | { type: "add-resource"; resource: IimlResourceEntry }
  | { type: "update-resource"; id: string; patch: Partial<IimlResourceEntry> }
  | { type: "delete-resource"; id: string }
  | { type: "undo" }
  | { type: "redo" };

export type {
  IimlAlignment,
  IimlAlignmentControlPoint,
  IimlAnnotation,
  IimlAnnotationFrame,
  IimlDocument,
  IimlGeometry,
  IimlPoint,
  IimlProcessingRun,
  IimlRelation,
  IimlRelationKind,
  IimlRelationOrigin,
  IimlReviewStatus,
  IimlStructuralLevel,
  VocabularyTerm
};
