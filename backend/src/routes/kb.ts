/**
 * 知识库 HTTP 边界（/api/kb/*）。
 *
 * GET  /kb/snapshot                 全量快照（人工录入规模，前端一次拉全）
 * GET  /kb/search?q=&category=      混合检索（Concept/Term/Segment/Source 混排）
 * GET  /kb/concepts/:id/detail      概念详情（词形/关系溯源/共现/文段/来源分布）
 * GET  /kb/concepts/:id/graph       概念局部子图
 * GET  /kb/graph/overview           概念树总览子图
 * GET  /kb/evidence/suggest?conceptId=   证据字面匹配建议
 * POST /kb/mentions/suggest { text }     文段录入预标建议
 * POST/PUT/DELETE 各实体 CRUD
 */

import express from "express";
import {
  createConcept,
  createRelation,
  createSegment,
  createSource,
  createTerm,
  deleteConcept,
  deleteRelation,
  deleteSegment,
  deleteSource,
  deleteTerm,
  loadKb,
  updateConcept,
  updateSegment,
  updateSource
} from "../services/kb/kb-store.js";
import {
  buildConceptDetail,
  buildLocalGraph,
  buildOverviewGraph,
  searchKb,
  suggestEvidenceForConcept,
  suggestMentionsForText
} from "../services/kb/kb-query.js";

export function createKbRouter(projectRoot: string): express.Router {
  const router = express.Router();

  router.get("/kb/snapshot", async (_req, res, next) => {
    try {
      res.json(await loadKb(projectRoot));
    } catch (error) {
      next(error);
    }
  });

  router.get("/kb/search", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const category = typeof req.query.category === "string" && req.query.category ? req.query.category : undefined;
      const kb = await loadKb(projectRoot);
      res.json({ results: searchKb(kb, q, category) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/kb/concepts/:id/detail", async (req, res, next) => {
    try {
      const kb = await loadKb(projectRoot);
      const detail = buildConceptDetail(kb, req.params.id);
      if (!detail) {
        res.status(404).json({ error: "concept_not_found" });
        return;
      }
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.get("/kb/concepts/:id/graph", async (req, res, next) => {
    try {
      const kb = await loadKb(projectRoot);
      res.json(buildLocalGraph(kb, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.get("/kb/graph/overview", async (_req, res, next) => {
    try {
      const kb = await loadKb(projectRoot);
      res.json(buildOverviewGraph(kb));
    } catch (error) {
      next(error);
    }
  });

  router.get("/kb/evidence/suggest", async (req, res, next) => {
    try {
      const conceptId = typeof req.query.conceptId === "string" ? req.query.conceptId : "";
      if (!conceptId) {
        res.status(400).json({ error: "conceptId_required" });
        return;
      }
      const kb = await loadKb(projectRoot);
      res.json({ suggestions: suggestEvidenceForConcept(kb, conceptId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/kb/mentions/suggest", async (req, res, next) => {
    try {
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      const kb = await loadKb(projectRoot);
      res.json({ suggestions: suggestMentionsForText(kb, text) });
    } catch (error) {
      next(error);
    }
  });

  // ---------- CRUD ----------
  // 业务校验错误统一转 422，带可读 message

  const asUnprocessable = (res: express.Response, error: unknown) => {
    res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
  };

  router.post("/kb/concepts", async (req, res) => {
    try {
      res.json(await createConcept(projectRoot, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.put("/kb/concepts/:id", async (req, res) => {
    try {
      res.json(await updateConcept(projectRoot, req.params.id, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.delete("/kb/concepts/:id", async (req, res) => {
    try {
      await deleteConcept(projectRoot, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.post("/kb/terms", async (req, res) => {
    try {
      res.json(await createTerm(projectRoot, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.delete("/kb/terms/:id", async (req, res) => {
    try {
      await deleteTerm(projectRoot, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.post("/kb/sources", async (req, res) => {
    try {
      res.json(await createSource(projectRoot, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.put("/kb/sources/:id", async (req, res) => {
    try {
      res.json(await updateSource(projectRoot, req.params.id, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.delete("/kb/sources/:id", async (req, res) => {
    try {
      await deleteSource(projectRoot, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.post("/kb/segments", async (req, res) => {
    try {
      res.json(await createSegment(projectRoot, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.put("/kb/segments/:id", async (req, res) => {
    try {
      res.json(await updateSegment(projectRoot, req.params.id, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.delete("/kb/segments/:id", async (req, res) => {
    try {
      await deleteSegment(projectRoot, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.post("/kb/relations", async (req, res) => {
    try {
      res.json(await createRelation(projectRoot, req.body));
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  router.delete("/kb/relations/:id", async (req, res) => {
    try {
      await deleteRelation(projectRoot, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      asUnprocessable(res, error);
    }
  });

  return router;
}
