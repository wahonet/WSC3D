/**
 * SAM3 概念词映射 + 错误格式化（纯函数）
 *
 * 从 App.tsx 抽出来，让中文概念词（人物 / 马 / 鸟 / 车 / 纹饰 …）→ 英文 SAM3
 * 提示词的扩展表可独立单测，且方便未来扩充成版本化配置词典。
 *
 * - `sam3PromptCandidates(prompt)`：输入中文/英文概念词，输出去重后的英文候选
 *   提示词数组（含同义词扩展），最多 6 个。SAM3 是英文模型，但画像石研究用中文，
 *   这层映射让标员用中文也能驱动 SAM3 文本概念分割。
 * - `uniqueSam3Prompts(prompts)`：去重（大小写无关）。
 * - `formatSam3Error(error, detail)`：把 SAM3 的英文错误（gated 权重 / 超时）翻成
 *   中文处置建议，给标员可操作提示。
 *
 * 不依赖 React，纯 TypeScript，配 sam3-prompts.test.ts。
 */

export function uniqueSam3Prompts(prompts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const prompt of prompts) {
    const value = prompt.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function sam3PromptCandidates(prompt: string): string[] {
  const value = prompt.trim();
  const lower = value.toLowerCase();
  const candidates = [value];

  if (/人|人物|人像|侍|官|吏|person|people|human|man|woman|figure|attendant|official/.test(lower)) {
    candidates.push("human figure", "figure", "person", "people", "human");
  }
  if (/马|馬|horse/.test(lower)) {
    candidates.push("horse", "horse figure", "animal");
  }
  if (/鸟|鳥|bird/.test(lower)) {
    candidates.push("bird", "bird figure", "animal");
  }
  if (/兽|獸|animal|beast/.test(lower)) {
    candidates.push("animal", "beast", "animal figure");
  }
  if (/车|車|chariot|cart|carriage/.test(lower)) {
    candidates.push("chariot", "carriage", "cart", "vehicle");
  }
  if (/纹|紋|饰|飾|ornament|pattern|motif|decorative/.test(lower)) {
    candidates.push("decorative pattern", "ornament", "pattern", "motif");
  }
  if (/骑|騎|rider/.test(lower)) {
    candidates.push("rider", "horse rider", "human figure", "horse");
  }

  return uniqueSam3Prompts(candidates).slice(0, 6);
}

export function formatSam3Error(error?: string, detail?: string): string {
  const raw = [error, detail].filter(Boolean).join(": ");
  if (
    /SAM3 checkpoint is not available locally|LocalEntryNotFoundError|facebook\/sam3|Access denied|requires approval|sam3\.pt/i.test(raw)
  ) {
    return [
      "SAM3 权重尚未就绪。",
      "请先在 Hugging Face 通过 facebook/sam3 访问审批并登录，",
      "然后下载权重到 ai-service\\weights\\sam3\\sam3.pt；",
      "也可以手动把 sam3.pt 放到这个目录后重启 AI 服务。"
    ].join("");
  }
  if (/WinError 10060|timed out|connection|connect timeout|ReadTimeout/i.test(raw)) {
    return "SAM3 权重下载连接超时。请设置代理或 Hugging Face 镜像后重启 AI 服务，或手动把 sam3.pt 放到 ai-service\\weights\\sam3\\sam3.pt。";
  }
  return raw || "SAM3 未返回具体错误。";
}
