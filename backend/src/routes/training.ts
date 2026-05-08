import express from "express";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { CatalogConfig, getCatalog } from "../services/catalog.js";
import { runPreflight } from "../services/preflight.js";
import { exportTrainingDataset } from "../services/training-export.js";

type CatalogLoader = typeof getCatalog;
const DATASET_NAME = "wsc-han-stone-v0";

export function createTrainingRouter(
  projectRoot: string,
  config: CatalogConfig,
  getCatalogImpl: CatalogLoader
): express.Router {
  const router = express.Router();
  let exportInFlight = false;

  router.post("/training/export", async (_req, res, next) => {
    if (exportInFlight) {
      res.status(409).json({ error: "export-in-progress", detail: "上一次导出还在进行，请稍候" });
      return;
    }
    exportInFlight = true;
    try {
      const summary = await exportTrainingDataset(projectRoot);
      res.json(summary);
    } catch (error) {
      next(error);
    } finally {
      exportInFlight = false;
    }
  });

  router.get("/preflight", async (_req, res, next) => {
    try {
      const report = await runPreflight(projectRoot, config, getCatalogImpl);
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  router.post("/training/reveal-dataset", async (_req, res, next) => {
    const absolutePath = path.join(projectRoot, "data", "datasets", DATASET_NAME);
    try {
      await access(absolutePath);
      revealDirectory(absolutePath);
      res.json({
        opened: true,
        datasetDir: path.relative(projectRoot, absolutePath).replace(/\\/g, "/"),
        absolutePath
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function revealDirectory(directory: string) {
  const command = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const child = spawn(command, [directory], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
