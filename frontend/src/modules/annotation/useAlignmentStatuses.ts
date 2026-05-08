import { useEffect, useState } from "react";
import { fetchAlignmentStatuses } from "../../api/iiml";

export function useAlignmentStatuses(
  selectedStoneId: string,
  hasAlignment: boolean
): Record<string, boolean> {
  const [alignmentStatuses, setAlignmentStatuses] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchAlignmentStatuses().then(setAlignmentStatuses).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedStoneId) return;
    setAlignmentStatuses((prev) => ({
      ...prev,
      [selectedStoneId]: hasAlignment
    }));
  }, [hasAlignment, selectedStoneId]);

  return alignmentStatuses;
}
