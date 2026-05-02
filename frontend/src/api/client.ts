export type DimensionData = {
  width?: number;
  height?: number;
  thickness?: number;
  unit: "cm";
  raw?: string;
  order: "height_width_thickness";
};

export type StoneListItem = {
  id: string;
  name: string;
  displayName: string;
  hasModel: boolean;
  hasMetadata: boolean;
  modelUrl?: string;
  thumbnailUrl?: string;
  metadata?: {
    stone_id: string;
    name: string;
    dimensions: DimensionData;
    dimension_note?: string;
    layerCount: number;
    source_file: string;
  };
};

export type StoneMetadata = {
  stone_id: string;
  name: string;
  dimensions: DimensionData;
  dimension_note?: string;
  layers: Array<{
    layer_index: number;
    title: string;
    source?: string;
    content: string;
    panels: Array<{
      panel_index: number;
      position: string;
      content: string;
      source?: string;
    }>;
  }>;
  source_file: string;
};

export type StoneListResponse = {
  generatedAt: string;
  summary: {
    modelCount: number;
    thumbnailCount: number;
    markdownCount: number;
    referenceImageCount: number;
    unmatchedModels: number;
    unmatchedMetadata: number;
  };
  stones: StoneListItem[];
};

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

export type AssemblyPlanPayload = {
  id?: string;
  name: string;
  items: AssemblyPlanItem[];
};

export type AssemblyPlanRecord = AssemblyPlanPayload & {
  id: string;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
};

export async function fetchStones(): Promise<StoneListResponse> {
  const response = await fetch("/api/stones");
  if (!response.ok) {
    throw new Error(`获取画像石列表失败：${response.status}`);
  }
  return response.json();
}

export async function fetchStoneMetadata(id: string): Promise<StoneMetadata> {
  const response = await fetch(`/api/stones/${encodeURIComponent(id)}/metadata`);
  if (!response.ok) {
    throw new Error(`获取画像石元数据失败：${response.status}`);
  }
  return response.json();
}

export async function fetchAssemblyPlans(): Promise<AssemblyPlanRecord[]> {
  const response = await fetch("/api/assembly-plans");
  if (!response.ok) {
    throw new Error(`获取拼接方案失败：${response.status}`);
  }
  return response.json();
}

export async function fetchAssemblyPlan(id: string): Promise<AssemblyPlanRecord> {
  const response = await fetch(`/api/assembly-plans/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`读取拼接方案失败：${response.status}`);
  }
  return response.json();
}

export async function saveAssemblyPlan(payload: AssemblyPlanPayload): Promise<AssemblyPlanRecord> {
  const response = await fetch("/api/assembly-plans", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`保存拼接方案失败：${response.status}`);
  }
  return response.json();
}
