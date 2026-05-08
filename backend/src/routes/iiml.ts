import express from "express";
import type { CatalogConfig, getCatalog } from "../services/catalog.js";
import { importHpsmlPackage } from "../services/hpsml.js";
import {
  getIimlContext,
  importMarkdownIntoIiml,
  listAlignments,
  loadIimlDoc,
  loadVocabulary,
  saveIimlDoc
} from "../services/iiml.js";

type CatalogLoader = typeof getCatalog;

export function createIimlRouter(
  projectRoot: string,
  config: CatalogConfig,
  getCatalogImpl: CatalogLoader
): express.Router {
  const router = express.Router();

  router.get("/terms", async (_req, res, next) => {
    try {
      res.json(await loadVocabulary(projectRoot));
    } catch (error) {
      next(error);
    }
  });

  router.get("/iiml/context", (_req, res) => {
    res.json(getIimlContext());
  });

  router.get("/iiml/alignments", async (_req, res, next) => {
    try {
      res.json(await listAlignments(projectRoot));
    } catch (error) {
      next(error);
    }
  });

  router.get("/iiml/:stoneId", async (req, res, next) => {
    try {
      res.json(await loadIimlDoc(projectRoot, config, getCatalogImpl, req.params.stoneId));
    } catch (error) {
      next(error);
    }
  });

  router.put("/iiml/:stoneId", async (req, res, next) => {
    try {
      res.json(await saveIimlDoc(projectRoot, req.params.stoneId, req.body));
    } catch (error) {
      next(error);
    }
  });

  router.post("/iiml/:stoneId/import-md", async (req, res, next) => {
    try {
      res.json(await importMarkdownIntoIiml(projectRoot, config, getCatalogImpl, req.params.stoneId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/hpsml/import", async (req, res, next) => {
    try {
      const stoneId = typeof req.query.stoneId === "string" ? req.query.stoneId : undefined;
      const conflictRaw = typeof req.query.conflict === "string" ? req.query.conflict : undefined;
      const conflict = conflictRaw === "skip" ? "skip" : "overwrite";
      const summary = await importHpsmlPackage(projectRoot, config, getCatalogImpl, req.body, {
        stoneId,
        conflictStrategy: conflict
      });
      res.json(summary);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
