import express from "express";
import {
  listAssemblyPlans,
  readAssemblyPlan,
  saveAssemblyPlan
} from "../services/assembly-plans.js";

export function createAssemblyRouter(assemblyPlanDir: string): express.Router {
  const router = express.Router();

  router.get("/assembly-plans", async (_req, res, next) => {
    try {
      res.json(await listAssemblyPlans(assemblyPlanDir));
    } catch (error) {
      next(error);
    }
  });

  router.get("/assembly-plans/:id", async (req, res, next) => {
    try {
      const plan = await readAssemblyPlan(assemblyPlanDir, req.params.id);
      if (!plan) {
        res.status(404).json({ error: "assembly_plan_not_found" });
        return;
      }
      res.json(plan);
    } catch (error) {
      next(error);
    }
  });

  router.post("/assembly-plans", async (req, res, next) => {
    try {
      const plan = await saveAssemblyPlan(assemblyPlanDir, req.body);
      res.status(201).json(plan);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
