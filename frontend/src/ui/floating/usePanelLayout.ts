import { useCallback, useEffect, useMemo, useState } from "react";
import type { PanelDefinition, PanelLayoutEntry, PanelLayoutState, PanelId } from "./types";

const STORAGE_PREFIX = "wsc3d-panels-v2";

function storageKey(workspace: string) {
  return `${STORAGE_PREFIX}:${workspace}`;
}

function buildDefaults(definitions: PanelDefinition[]): PanelLayoutState {
  const state: PanelLayoutState = {};
  let z = 10;
  definitions.forEach((def, index) => {
    state[def.id] = {
      ...def.defaultRect,
      open: def.defaultOpen !== false,
      collapsed: false,
      zIndex: z + index
    };
  });
  return state;
}

function clampRect(entry: PanelLayoutEntry, minW: number, minH: number, vw: number, vh: number): PanelLayoutEntry {
  const width = Math.max(minW, Math.min(entry.width, vw - 16));
  const height = Math.max(minH, Math.min(entry.height, vh - varTopbar() - 16));
  const x = Math.max(8, Math.min(entry.x, vw - width - 8));
  const y = Math.max(varTopbar() + 8, Math.min(entry.y, vh - (entry.collapsed ? 36 : height) - 8));
  return { ...entry, x, y, width, height };
}

function varTopbar() {
  return 48;
}

function loadState(workspace: string, definitions: PanelDefinition[]): PanelLayoutState {
  const defaults = buildDefaults(definitions);
  try {
    const raw = localStorage.getItem(storageKey(workspace));
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as PanelLayoutState;
    const merged = { ...defaults };
    for (const def of definitions) {
      const saved = parsed[def.id];
      if (saved) {
        merged[def.id] = {
          ...merged[def.id],
          ...saved,
          width: saved.width ?? def.defaultRect.width,
          height: saved.height ?? def.defaultRect.height
        };
      }
    }
    return merged;
  } catch {
    return defaults;
  }
}

function persist(workspace: string, state: PanelLayoutState) {
  try {
    localStorage.setItem(storageKey(workspace), JSON.stringify(state));
  } catch {
    /* ignore quota */
  }
}

export function usePanelLayout(workspace: string, definitions: PanelDefinition[]) {
  const defKey = useMemo(() => definitions.map((d) => d.id).join(","), [definitions]);
  const [layout, setLayout] = useState<PanelLayoutState>(() => loadState(workspace, definitions));

  useEffect(() => {
    setLayout(loadState(workspace, definitions));
  }, [workspace, defKey, definitions]);

  useEffect(() => {
    persist(workspace, layout);
  }, [workspace, layout]);

  const bringToFront = useCallback((id: PanelId) => {
    setLayout((prev) => {
      const maxZ = Math.max(...Object.values(prev).map((e) => e.zIndex), 10);
      return { ...prev, [id]: { ...prev[id], zIndex: maxZ + 1 } };
    });
  }, []);

  const updatePanel = useCallback(
    (id: PanelId, patch: Partial<PanelLayoutEntry>) => {
      setLayout((prev) => {
        const def = definitions.find((d) => d.id === id);
        const minW = def?.minWidth ?? 240;
        const minH = def?.minHeight ?? 160;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const next = { ...prev[id], ...patch };
        return { ...prev, [id]: clampRect(next, minW, minH, vw, vh) };
      });
    },
    [definitions]
  );

  const toggleOpen = useCallback((id: PanelId, open?: boolean) => {
    setLayout((prev) => ({
      ...prev,
      [id]: { ...prev[id], open: open ?? !prev[id].open }
    }));
  }, []);

  const toggleCollapsed = useCallback((id: PanelId) => {
    setLayout((prev) => ({
      ...prev,
      [id]: { ...prev[id], collapsed: !prev[id].collapsed }
    }));
  }, []);

  const resetLayout = useCallback(() => {
    const next = buildDefaults(definitions);
    setLayout(next);
    persist(workspace, next);
  }, [definitions, workspace]);

  return {
    layout,
    bringToFront,
    updatePanel,
    toggleOpen,
    toggleCollapsed,
    resetLayout,
    definitions
  };
}
