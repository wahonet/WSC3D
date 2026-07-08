import express from "express";
import {
  ResourceInputError,
  bufferFromStoneResourceBody,
  deleteStoneResource,
  listStoneResources,
  saveAnnotationAssets,
  uploadStoneResource
} from "../services/stone-resources.js";

export function createResourcesRouter(stoneResourceDir: string): express.Router {
  const router = express.Router();

  router.get("/stones/:id/resources", async (req, res, next) => {
    try {
      res.json(await listStoneResources(stoneResourceDir, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.post("/stones/:id/resources", async (req, res, next) => {
    try {
      const rawType = typeof req.query.type === "string"
        ? req.query.type
        : typeof (req.body as { type?: unknown })?.type === "string"
        ? (req.body as { type: string }).type
        : "ortho";
      const buffer = bufferFromStoneResourceBody(req.body);
      res.json(await uploadStoneResource(stoneResourceDir, req.params.id, rawType, buffer ?? Buffer.alloc(0)));
    } catch (error) {
      if (error instanceof ResourceInputError) {
        res.status(error.statusCode).json({ error: error.code, ...error.extra });
        return;
      }
      next(error);
    }
  });

  router.delete("/stones/:id/resources/:fileName", async (req, res, next) => {
    try {
      res.json(await deleteStoneResource(stoneResourceDir, req.params.id, req.params.fileName));
    } catch (error) {
      if (error instanceof ResourceInputError) {
        res.status(error.statusCode).json({ error: error.code, ...error.extra });
        return;
      }
      next(error);
    }
  });

  // P2：标注外观资产（mask / cutout / thumbnail base64）落盘，返回可引用 URI。
  router.post("/stones/:id/annotations/:annotationId/assets", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        maskPngBase64?: string;
        cutoutPngBase64?: string;
        thumbnailPngBase64?: string;
      };
      res.json(
        await saveAnnotationAssets(stoneResourceDir, req.params.id, req.params.annotationId, {
          mask: body.maskPngBase64,
          cutout: body.cutoutPngBase64,
          thumbnail: body.thumbnailPngBase64
        })
      );
    } catch (error) {
      if (error instanceof ResourceInputError) {
        res.status(error.statusCode).json({ error: error.code, ...error.extra });
        return;
      }
      next(error);
    }
  });

  return router;
}
