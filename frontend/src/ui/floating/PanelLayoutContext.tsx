import { createContext, useContext, type ReactNode } from "react";
import type { PanelDefinition } from "./types";
import { usePanelLayout } from "./usePanelLayout";

type PanelLayoutContextValue = ReturnType<typeof usePanelLayout>;

const PanelLayoutContext = createContext<PanelLayoutContextValue | null>(null);

type PanelLayoutProviderProps = {
  workspace: string;
  definitions: PanelDefinition[];
  children: ReactNode;
};

export function PanelLayoutProvider({ workspace, definitions, children }: PanelLayoutProviderProps) {
  const value = usePanelLayout(workspace, definitions);
  return <PanelLayoutContext.Provider value={value}>{children}</PanelLayoutContext.Provider>;
}

export function usePanelLayoutContext() {
  const ctx = useContext(PanelLayoutContext);
  if (!ctx) throw new Error("usePanelLayoutContext must be used within PanelLayoutProvider");
  return ctx;
}
