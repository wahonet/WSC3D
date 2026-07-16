import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchAssemblyPlans, type AssemblyPlanRecord } from "../../api/client";

type AssemblyPlansContextValue = {
  savedPlans: AssemblyPlanRecord[];
  setSavedPlans: React.Dispatch<React.SetStateAction<AssemblyPlanRecord[]>>;
};

const AssemblyPlansContext = createContext<AssemblyPlansContextValue | null>(null);

export function AssemblyPlansProvider({ children }: { children: ReactNode }) {
  const [savedPlans, setSavedPlans] = useState<AssemblyPlanRecord[]>([]);

  useEffect(() => {
    fetchAssemblyPlans()
      .then(setSavedPlans)
      .catch(() => setSavedPlans([]));
  }, []);

  const value = useMemo(() => ({ savedPlans, setSavedPlans }), [savedPlans]);

  return <AssemblyPlansContext.Provider value={value}>{children}</AssemblyPlansContext.Provider>;
}

export function useAssemblyPlans() {
  const ctx = useContext(AssemblyPlansContext);
  if (!ctx) throw new Error("useAssemblyPlans must be used within AssemblyPlansProvider");
  return ctx;
}
