import express from "express";
import type { CatalogConfig, getCatalog } from "../services/catalog.js";
import { matchPicHealthToCatalog } from "../services/pic-catalog.js";
import { getPicDir, scanPicDir } from "../services/pic.js";
import { bindStoneToPic, loadBindings, unbindStone } from "../services/pic-bindings.js";

type CatalogLoader = typeof getCatalog;

export function createPicRouter(
  projectRoot: string,
  config: CatalogConfig,
  getCatalogImpl: CatalogLoader
): express.Router {
  const router = express.Router();

  router.get("/pic/health", async (_req, res, next) => {
    try {
      const [picHealth, catalog] = await Promise.all([
        scanPicDir(getPicDir(projectRoot)),
        getCatalogImpl(config)
      ]);
      const { matched, unmatchedStones } = matchPicHealthToCatalog(catalog, picHealth);
      res.json({
        picDir: picHealth.picDir,
        exists: picHealth.exists,
        totalFiles: picHealth.totalFiles,
        matchedCount: matched.length,
        matched,
        unmatchedStones,
        duplicateKeys: picHealth.duplicateKeys,
        unrecognizedFiles: picHealth.unrecognizedFiles
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/pic/list", async (_req, res, next) => {
    try {
      const picDir = getPicDir(projectRoot);
      const [picHealth, bindings, catalog] = await Promise.all([
        scanPicDir(picDir),
        loadBindings(projectRoot),
        getCatalogImpl(config)
      ]);
      const bindingsByCurrent = new Map(bindings.map((b) => [b.currentFileName, b]));
      const stoneById = new Map(catalog.stones.map((s) => [s.id, s]));
      const files = Object.values(picHealth.byNumericKey)
        .flat()
        .concat(
          picHealth.unrecognizedFiles.map((fileName) => ({
            fileName,
            path: `${picDir}/${fileName}`,
            numericKey: "",
            face: undefined,
            size: 0
          }))
        )
        .map((entry) => {
          const binding = bindingsByCurrent.get(entry.fileName);
          return {
            fileName: entry.fileName,
            numericKey: entry.numericKey || undefined,
            face: entry.face,
            size: entry.size,
            isBound: Boolean(binding),
            boundStoneId: binding?.stoneId,
            boundFace: binding?.face,
            boundDisplayName: binding ? stoneById.get(binding.stoneId)?.displayName : undefined,
            originalFileName: binding?.originalFileName
          };
        })
        .sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-Hans-CN", { numeric: true }));
      res.json({
        picDir: picHealth.picDir,
        exists: picHealth.exists,
        totalFiles: picHealth.totalFiles,
        duplicateKeys: picHealth.duplicateKeys,
        unrecognizedFiles: picHealth.unrecognizedFiles,
        bindings,
        files
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/pic/bind", async (req, res, next) => {
    try {
      const { stoneId, originalFileName, face } = (req.body ?? {}) as {
        stoneId?: string;
        originalFileName?: string;
        face?: string;
      };
      if (!stoneId || !originalFileName) {
        res.status(400).json({ error: "missing-params", detail: "需要 stoneId 与 originalFileName" });
        return;
      }
      const catalog = await getCatalogImpl(config);
      const stone = catalog.stones.find((s) => s.id === stoneId);
      if (!stone) {
        res.status(404).json({ error: "stone-not-found", detail: stoneId });
        return;
      }
      const result = await bindStoneToPic(
        projectRoot,
        getPicDir(projectRoot),
        stoneId,
        stone.displayName,
        originalFileName,
        face
      );
      if (!result.ok) {
        res.status(409).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/pic/unbind", async (req, res, next) => {
    try {
      const { stoneId, face } = (req.body ?? {}) as { stoneId?: string; face?: string };
      if (!stoneId) {
        res.status(400).json({ error: "missing-params", detail: "需要 stoneId" });
        return;
      }
      const result = await unbindStone(projectRoot, getPicDir(projectRoot), stoneId, face);
      if (!result.ok) {
        res.status(409).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
