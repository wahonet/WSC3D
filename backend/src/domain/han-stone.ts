/**
 * 汉画像石领域契约常量。
 *
 * 这里是后端训练校验、IIML schema、预检与 COCO 导出的单一来源；前端同名
 * 类别表应只负责 UI 文案和 motif 建议，不再维护另一份训练用枚举。
 */

export const HAN_STONE_CATEGORIES = [
  "figure-deity",
  "figure-immortal",
  "figure-mythic-ruler",
  "figure-loyal-assassin",
  "figure-filial-son",
  "figure-virtuous-woman",
  "figure-music-dance",
  "chariot-procession",
  "mythic-creature",
  "celestial",
  "daily-life-scene",
  "architecture",
  "inscription",
  "pattern-border",
  "unknown"
] as const;

export type HanStoneCategory = (typeof HAN_STONE_CATEGORIES)[number];

export const HAN_STONE_CATEGORY_SET: ReadonlySet<string> = new Set(HAN_STONE_CATEGORIES);

export const NARRATIVE_CATEGORIES_NEED_MOTIF: ReadonlySet<string> = new Set([
  "figure-loyal-assassin",
  "figure-filial-son",
  "figure-virtuous-woman"
]);

export const TRAINING_COCO_CATEGORIES = [
  { id: 1, name: "figure-deity", supercategory: "mythic" },
  { id: 2, name: "figure-immortal", supercategory: "mythic" },
  { id: 3, name: "figure-mythic-ruler", supercategory: "historic" },
  { id: 4, name: "figure-loyal-assassin", supercategory: "historic" },
  { id: 5, name: "figure-filial-son", supercategory: "historic" },
  { id: 6, name: "figure-virtuous-woman", supercategory: "historic" },
  { id: 7, name: "figure-music-dance", supercategory: "daily-life" },
  { id: 8, name: "chariot-procession", supercategory: "daily-life" },
  { id: 9, name: "mythic-creature", supercategory: "mythic" },
  { id: 10, name: "celestial", supercategory: "mythic" },
  { id: 11, name: "daily-life-scene", supercategory: "daily-life" },
  { id: 12, name: "architecture", supercategory: "daily-life" },
  { id: 13, name: "inscription", supercategory: "meta" },
  { id: 14, name: "pattern-border", supercategory: "meta" }
] as const;

export const TRAINING_COCO_CATEGORY_ID_BY_NAME: ReadonlyMap<string, number> = new Map(
  TRAINING_COCO_CATEGORIES.map((category) => [category.name as string, category.id])
);

export const STRUCTURAL_LEVELS_V8: ReadonlySet<string> = new Set([
  "whole",
  "scene",
  "figure",
  "component",
  "trace",
  "inscription",
  "damage",
  "unknown"
]);

export const ANNOTATION_QUALITY_TIERS = ["weak", "silver", "gold"] as const;
export const ANNOTATION_QUALITY_TIER_SET: ReadonlySet<string> = new Set(ANNOTATION_QUALITY_TIERS);

export const GEOMETRY_INTENTS = [
  "visible_trace",
  "semantic_extent",
  "reconstructed_extent"
] as const;
export const GEOMETRY_INTENT_SET: ReadonlySet<string> = new Set(GEOMETRY_INTENTS);

export const TRAINING_ROLES = ["train", "validation", "holdout"] as const;
export const TRAINING_ROLE_SET: ReadonlySet<string> = new Set(TRAINING_ROLES);

export const ANNOTATION_ISSUES = [
  "low_contrast",
  "texture_confusion",
  "ambiguous_boundary",
  "occluded_or_worn",
  "oversegmented",
  "undersegmented",
  "class_uncertain",
  "needs_expert_review"
] as const;
