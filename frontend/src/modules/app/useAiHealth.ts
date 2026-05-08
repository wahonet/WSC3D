import { useEffect, useState } from "react";
import { fetchAiHealth, type AiHealthResponse } from "../../api/ai";

export function useAiHealth(): AiHealthResponse | undefined {
  const [health, setHealth] = useState<AiHealthResponse | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let delay = 10_000;

    const tick = async () => {
      try {
        const health = await fetchAiHealth();
        if (!alive) return;
        setHealth(health);
        if (!health.sam || health.sam.ready || health.sam.status === "error") return;
      } catch {
        if (!alive) return;
        setHealth(undefined);
      }
      timer = window.setTimeout(tick, delay);
      delay = Math.min(delay * 2, 60_000);
    };

    tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return health;
}
