import { useEffect, useState } from "react";
import { fetchAiHealth, type AiHealthResponse } from "../../api/ai";

/**
 * AI 服务健康轮询。
 *
 * 关键设计：**永不停止轮询**。AI 服务（uvicorn）可能崩溃后被 concurrently
 * 自动重启，重启后 SAM3 回到 pending（懒加载）状态；若轮询在 ready/error
 * 后停止，前端会拿着过期状态把 SAM3 按钮永久禁用（表现为"只能用一次"）。
 * 未就绪时 10s 一轮，就绪/错误后降为 60s 心跳，开销可忽略。
 */
export function useAiHealth(): AiHealthResponse | undefined {
  const [health, setHealth] = useState<AiHealthResponse | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      let next = 10_000;
      try {
        const result = await fetchAiHealth();
        if (!alive) return;
        setHealth(result);
        const settled = result.sam3?.ready || result.sam3?.status === "error";
        next = settled ? 60_000 : 10_000;
      } catch {
        if (!alive) return;
        setHealth(undefined);
        next = 10_000;
      }
      timer = window.setTimeout(tick, next);
    };

    tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return health;
}
