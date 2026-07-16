import { createContext, useContext, useState, type ReactNode } from "react";

export type AnnotationSavePhase = "idle" | "dirty" | "saving" | "saved" | "error";

export type AnnotationSaveState = {
  phase: AnnotationSavePhase;
  savedAt?: string;
  error?: string;
};

type AnnotationStatusContextValue = {
  saveState: AnnotationSaveState;
  statusMessage?: string;
  // 当前石头的 IIML 是否已有 4 点对齐（culturalObject.alignment）；
  // 顶栏石头下拉用它实时更新 ✓ 前缀，不必等后端 /iiml/alignments 重新拉取
  hasAlignment: boolean;
  setSaveState: (state: AnnotationSaveState) => void;
  setStatusMessage: (msg: string) => void;
  setHasAlignment: (value: boolean) => void;
};

const AnnotationStatusContext = createContext<AnnotationStatusContextValue | null>(null);

export function AnnotationStatusProvider({ children }: { children: ReactNode }) {
  const [saveState, setSaveState] = useState<AnnotationSaveState>({ phase: "idle" });
  const [statusMessage, setStatusMessage] = useState<string>();
  const [hasAlignment, setHasAlignment] = useState(false);

  return (
    <AnnotationStatusContext.Provider
      value={{ saveState, statusMessage, hasAlignment, setSaveState, setStatusMessage, setHasAlignment }}
    >
      {children}
    </AnnotationStatusContext.Provider>
  );
}

export function useAnnotationStatus() {
  const ctx = useContext(AnnotationStatusContext);
  if (!ctx) throw new Error("useAnnotationStatus must be used within AnnotationStatusProvider");
  return ctx;
}
