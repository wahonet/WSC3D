import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchStoneMetadata, fetchStones, type StoneListResponse, type StoneMetadata } from "../../api/client";
import type { StoneListItem } from "../../api/client";

type StoneSelectionContextValue = {
  catalog?: StoneListResponse;
  metadata?: StoneMetadata;
  selectedId: string;
  selectedStone?: StoneListItem;
  error?: string;
  requestSelectStone: (nextId: string, options?: { skipDirtyCheck?: boolean }) => void;
  setSelectedId: (id: string) => void;
  hasUnsavedAnnotation: boolean;
  setHasUnsavedAnnotation: (value: boolean) => void;
  refreshCatalog: () => void;
};

const StoneSelectionContext = createContext<StoneSelectionContextValue | null>(null);

export function StoneSelectionProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<StoneListResponse>();
  const [metadata, setMetadata] = useState<StoneMetadata>();
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string>();
  const [hasUnsavedAnnotation, setHasUnsavedAnnotation] = useState(false);

  useEffect(() => {
    fetchStones()
      .then((data) => {
        setCatalog(data);
        const firstWithModel = data.stones.find((stone) => stone.hasModel);
        setSelectedId(firstWithModel?.id ?? data.stones[0]?.id ?? "");
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setMetadata(undefined);
    fetchStoneMetadata(selectedId)
      .then(setMetadata)
      .catch(() => setMetadata(undefined));
  }, [selectedId]);

  const selectedStone = useMemo(
    () => catalog?.stones.find((stone) => stone.id === selectedId),
    [catalog?.stones, selectedId]
  );

  const requestSelectStone = useCallback(
    (nextId: string, options?: { skipDirtyCheck?: boolean }) => {
      if (!nextId || nextId === selectedId) return;
      if (
        !options?.skipDirtyCheck &&
        hasUnsavedAnnotation &&
        !window.confirm("当前标注还有未保存或保存失败的改动。确定要切换画像石吗？")
      ) {
        return;
      }
      setSelectedId(nextId);
    },
    [hasUnsavedAnnotation, selectedId]
  );

  const refreshCatalog = useCallback(() => {
    fetchStones()
      .then(setCatalog)
      .catch((err: Error) => setError(err.message));
  }, []);

  const value = useMemo(
    () => ({
      catalog,
      metadata,
      selectedId,
      selectedStone,
      error,
      requestSelectStone,
      setSelectedId,
      hasUnsavedAnnotation,
      setHasUnsavedAnnotation,
      refreshCatalog
    }),
    [catalog, metadata, selectedId, selectedStone, error, requestSelectStone, hasUnsavedAnnotation, refreshCatalog]
  );

  return <StoneSelectionContext.Provider value={value}>{children}</StoneSelectionContext.Provider>;
}

export function useStoneSelection() {
  const ctx = useContext(StoneSelectionContext);
  if (!ctx) throw new Error("useStoneSelection must be used within StoneSelectionProvider");
  return ctx;
}
