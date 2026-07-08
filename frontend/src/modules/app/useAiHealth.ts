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
        // P0 收敛：主流程只关心 SAM3。ready / error 是终态，停止轮询；
        // pending（懒加载未触发）/ loading（加载中）继续低频轮询保持 UI 同步。
        if (health.sam3?.ready || health.sam3?.status === "error") return;
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
