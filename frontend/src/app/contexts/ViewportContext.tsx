import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type BackgroundMode = "black" | "gray" | "white";

type ViewportContextValue = {
  background: BackgroundMode;
  setBackground: (mode: BackgroundMode) => void;
  resetToken: number;
  bumpReset: () => void;
};

const ViewportContext = createContext<ViewportContextValue | null>(null);

export function ViewportProvider({ children }: { children: ReactNode }) {
  const [background, setBackground] = useState<BackgroundMode>("black");
  const [resetToken, setResetToken] = useState(0);
  const bumpReset = useCallback(() => setResetToken((v) => v + 1), []);

  const value = useMemo(
    () => ({ background, setBackground, resetToken, bumpReset }),
    [background, resetToken, bumpReset]
  );

  return <ViewportContext.Provider value={value}>{children}</ViewportContext.Provider>;
}

export function useViewport() {
  const ctx = useContext(ViewportContext);
  if (!ctx) throw new Error("useViewport must be used within ViewportProvider");
  return ctx;
}
