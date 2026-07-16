import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type WorkspaceMode = "viewer" | "annotation";

type WorkspaceModeContextValue = {
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  hasEnteredAnnotation: boolean;
  isAnnotationActive: boolean;
};

const WorkspaceModeContext = createContext<WorkspaceModeContextValue | null>(null);

export function WorkspaceModeProvider({ children }: { children: ReactNode }) {
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("viewer");
  const [hasEnteredAnnotation, setHasEnteredAnnotation] = useState(false);

  const isAnnotationActive = workspaceMode === "annotation";

  useEffect(() => {
    if (isAnnotationActive && !hasEnteredAnnotation) setHasEnteredAnnotation(true);
  }, [hasEnteredAnnotation, isAnnotationActive]);

  const value = useMemo(
    () => ({
      workspaceMode,
      setWorkspaceMode,
      hasEnteredAnnotation,
      isAnnotationActive
    }),
    [workspaceMode, hasEnteredAnnotation, isAnnotationActive]
  );

  return <WorkspaceModeContext.Provider value={value}>{children}</WorkspaceModeContext.Provider>;
}

export function useWorkspaceMode() {
  const ctx = useContext(WorkspaceModeContext);
  if (!ctx) throw new Error("useWorkspaceMode must be used within WorkspaceModeProvider");
  return ctx;
}
