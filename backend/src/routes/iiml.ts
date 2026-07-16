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
import { loadKb } from "../services/kb/kb-store.js";
import { projectVocabulary } from "../services/kb/kb-vocabulary.js";

type CatalogLoader = typeof getCatalog;

export function createIimlRouter(
  projectRoot: string,
  config: CatalogConfig,
  getCatalogImpl: CatalogLoader
): express.Router {
  const router = express.Router();

  router.get("/terms", async (_req, res, next) => {
    try {
      // 概念库已建立时由 KB 投影旧词表结构（term.id = conceptId，标注选词
      // 即自然挂到概念）；概念库为空回退旧 data/terms.json，冷启动不受影响。
      const kb = await loadKb(projectRoot);
      if (kb.concepts.length > 0) {
        res.json(projectVocabulary(kb));
        return;
      }
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
      // P4：把石头实测尺寸（cm）传给保存管线，派生 anchor.physical。
      // catalog 加载失败不阻塞保存（anchor 只是少物理换算）。
      let dimensions: { width?: number; height?: number } | undefined;
      try {
        const catalog = await getCatalogImpl(config);
        const stone = catalog.stones.find((entry) => entry.id === req.params.stoneId);
        dimensions = stone?.metadata?.dimensions;
      } catch {
        dimensions = undefined;
      }
      res.json(await saveIimlDoc(projectRoot, req.params.stoneId, req.body, dimensions));
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
