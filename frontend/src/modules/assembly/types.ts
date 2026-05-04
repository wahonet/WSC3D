/**
 * 拼接模块本地类型定义
 *
 * 拼接模块内部多个组件（Workspace / Panel / AdjustControls）共享的领域类型：
 * - `AssemblyTransform`：position + quaternion + scale 的 transform 三元组
 * - `AssemblyItem`：拼接列表中一项，关联 stone + 当前 transform + 锁定标记
 * - `AssemblyDimensions`：模型 / 元数据来源的"长边等比"尺寸
 * - `FaceName` / `FaceSelection` / `SnapRequest`：面对面贴合相关
 */

import type { StoneListItem } from "../../api/client";

export type FaceName = "left" | "right" | "top" | "bottom" | "front" | "back";

export type AssemblySlot = "a" | "b";

export type AssemblyTransform = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: number;
};

export type AssemblyDimensions = {
  width: number;
  length: number;
  thickness: number;
  longEdge: number;
  unit: "cm" | "model";
  source: "metadata" | "model";
};

export type AssemblyItem = {
  instanceId: string;
  stone: StoneListItem;
  locked: boolean;
  transform: AssemblyTransform;
  baseDimensions?: AssemblyDimensions;
};

export type FaceSelection = {
  instanceId: string;
  face: FaceName;
};

export type SnapRequest = {
  requestId: number;
  a: FaceSelection;
  b: FaceSelection;
};

export const faceLabels: Record<FaceName, string> = {
  left: "左面",
  right: "右面",
  top: "上面",
  bottom: "下面",
  front: "正面",
  back: "背面"
};
