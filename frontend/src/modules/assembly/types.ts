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
