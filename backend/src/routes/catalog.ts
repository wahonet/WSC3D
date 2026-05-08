import express from "express";
import type { CatalogConfig, getCatalog } from "../services/catalog.js";

type CatalogLoader = typeof getCatalog;

export function createCatalogRouter(config: CatalogConfig, getCatalogImpl: CatalogLoader): express.Router {
  const router = express.Router();

  router.get("/scan", async (_req, res, next) => {
    try {
      const catalog = await getCatalogImpl(config);
      res.json(catalog.summary);
    } catch (error) {
      next(error);
    }
  });

  router.post("/scan/refresh", async (_req, res, next) => {
    try {
      const catalog = await getCatalogImpl(config, true);
      res.json(catalog.summary);
    } catch (error) {
      next(error);
    }
  });

  router.get("/stones", async (_req, res, next) => {
    try {
      const catalog = await getCatalogImpl(config);
      res.json({
        generatedAt: catalog.generatedAt,
        summary: catalog.summary,
        stones: catalog.stones.map(({ model, thumbnail, metadata, ...stone }) => ({
          ...stone,
          model: model ? { fileName: model.fileName, size: model.size, extension: model.extension } : undefined,
          thumbnail: thumbnail
            ? { fileName: thumbnail.fileName, size: thumbnail.size, extension: thumbnail.extension }
            : undefined,
          metadata: metadata
            ? {
                stone_id: metadata.stone_id,
                name: metadata.name,
                dimensions: metadata.dimensions,
                dimension_note: metadata.dimension_note,
                layerCount: metadata.layers.length,
                source_file: metadata.source_file
              }
            : undefined
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/stones/:id/metadata", async (req, res, next) => {
    try {
      const catalog = await getCatalogImpl(config);
      const stone = catalog.stones.find((item) => item.id === req.params.id);
      if (!stone?.metadata) {
        res.status(404).json({ error: "metadata_not_found" });
        return;
      }
      res.json(stone.metadata);
    } catch (error) {
      next(error);
    }
  });

  router.get("/stones/:id/model", async (req, res, next) => {
    try {
      const catalog = await getCatalogImpl(config);
      const stone = catalog.stones.find((item) => item.id === req.params.id);
      if (!stone?.model) {
        res.status(404).json({ error: "model_not_found" });
        return;
      }
      res.sendFile(stone.model.path);
    } catch (error) {
      next(error);
    }
  });

  router.get("/reference-images", async (_req, res, next) => {
    try {
      const catalog = await getCatalogImpl(config);
      res.json(
        catalog.referenceImages.map((image) => ({
          fileName: image.fileName,
          size: image.size,
          url: `/assets/reference/${encodeURIComponent(image.fileName)}`
        }))
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/catalog/health", async (_req, res, next) => {
    try {
      const catalog = await getCatalogImpl(config);
      res.json({
        overrideSourcePath: catalog.health.overrideSourcePath,
        summary: {
          totalStones: catalog.stones.length,
          stonesWithModel: catalog.stones.filter((s) => s.hasModel).length,
          stonesWithMetadata: catalog.stones.filter((s) => s.hasMetadata).length,
          orphanModels: catalog.health.orphanModels.length,
          unmatchedMetadata: catalog.health.unmatchedMetadata.length,
          numericKeyConflicts: catalog.health.numericKeyConflicts.length,
          unrecognizedRules: catalog.health.unrecognizedRules.length
        },
        ...catalog.health
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
