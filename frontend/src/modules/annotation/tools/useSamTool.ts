import { useCallback } from "react";
import { runSamSegmentation } from "../../../api/client";

export function useSamTool(captureImage: () => string) {
  return useCallback(
    async (point: { x: number; y: number }) =>
      runSamSegmentation({
        imageBase64: captureImage(),
        prompts: [{ type: "point", x: point.x, y: point.y, label: 1 }]
      }),
    [captureImage]
  );
}
