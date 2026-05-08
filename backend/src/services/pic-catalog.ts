import type { Catalog } from "../types.js";
import type { PicHealth } from "./pic.js";
import { stoneIdToNumericKey } from "./pic.js";

export type PicCatalogMatch = {
  matched: Array<{ stoneId: string; fileName: string }>;
  unmatchedStones: string[];
};

export function matchPicHealthToCatalog(catalog: Catalog, picHealth: PicHealth): PicCatalogMatch {
  const matched: Array<{ stoneId: string; fileName: string }> = [];
  const unmatchedStones: string[] = [];

  for (const stone of catalog.stones) {
    const key = stoneIdToNumericKey(stone.id);
    const pic = key ? picHealth.byNumericKey[key]?.[0] : undefined;
    if (pic) {
      matched.push({ stoneId: stone.id, fileName: pic.fileName });
    } else {
      unmatchedStones.push(stone.id);
    }
  }

  return { matched, unmatchedStones };
}
