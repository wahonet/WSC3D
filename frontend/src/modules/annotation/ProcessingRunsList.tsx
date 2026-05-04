/**
 * AI 处理记录视图 `ProcessingRunsList`
 *
 * 详情面板里的"AI 处理记录"折叠 section，把每次 SAM / YOLO / Canny 调用
 * 留下的 `processingRun` 记录展示出来，让候选标注的来源可追溯。
 *
 * 这是学术溯源的关键 ——
 * 论文 24 / 25 / 26 / 34 都强调"AI 候选必须可追溯到具体模型 + 参数 + 时间"。
 *
 * 显示规则：
 * - **annotation 传入时**：只显示产生过该标注的 run（按 endedAt 降序）
 * - **无 annotation**：显示全部 run（List tab 总览，预留扩展）
 * - 失败 / 无产出的 run 用浅红条；成功 run 显示模型 + 时间 + 产出数
 * - 点击产出 annotation id 跳转到对应标注（`onSelectAnnotation` 提供时）
 *
 * 视觉：与 RelationsEditor 同视觉容器（深色卡片 + head + 列表），保持详情面板
 * 末尾的视觉一致。
 */

import { ChevronDown, ChevronRight, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { IimlAnnotation, IimlProcessingRun } from "./types";

type ProcessingRunsListProps = {
  // 当前选中的标注；只显示"产生了该标注"或"涉及该标注"的 run。
  // 不传则显示全部 run（用于 List tab 总览）
  annotation?: IimlAnnotation;
  runs: IimlProcessingRun[];
  onSelectAnnotation?: (id: string) => void;
};

const methodLabels: Record<string, string> = {
  sam: "SAM",
  "sam-merge": "SAM 合并",
  yolo: "YOLO",
  canny: "Canny"
};

export function ProcessingRunsList({
  annotation,
  runs,
  onSelectAnnotation
}: ProcessingRunsListProps) {
  const [expanded, setExpanded] = useState(false);

  const filteredRuns = useMemo(() => {
    if (!annotation) {
      return runs.slice().sort(byEndedDesc);
    }
    return runs
      .filter((run) => run.resultAnnotationIds?.includes(annotation.id))
      .sort(byEndedDesc);
  }, [annotation, runs]);

  if (filteredRuns.length === 0) {
    return null;
  }

  return (
    <div className="processing-runs">
      <button
        type="button"
        className="processing-runs-head"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Wand2 size={13} />
        <span className="processing-runs-title">AI 处理记录</span>
        <span className="muted-text">{filteredRuns.length} 条</span>
      </button>
      {expanded ? (
        <ul className="processing-runs-list">
          {filteredRuns.map((run) => (
            <ProcessingRunRow
              key={run.id}
              run={run}
              onSelectAnnotation={onSelectAnnotation}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function byEndedDesc(a: IimlProcessingRun, b: IimlProcessingRun): number {
  const aTime = a.endedAt ?? a.startedAt;
  const bTime = b.endedAt ?? b.startedAt;
  return bTime.localeCompare(aTime);
}

function ProcessingRunRow({
  run,
  onSelectAnnotation
}: {
  run: IimlProcessingRun;
  onSelectAnnotation?: (id: string) => void;
}) {
  const failed = Boolean(run.error) || (run.resultAnnotationIds?.length ?? 0) === 0;
  const time = formatRelativeTime(run.endedAt ?? run.startedAt);
  const methodLabel = methodLabels[run.method] ?? run.method;
  const inputSummary = formatInput(run.input);
  return (
    <li className={failed ? "processing-runs-item is-failed" : "processing-runs-item"}>
      <div className="processing-runs-item-head">
        <span className="processing-runs-method">{methodLabel}</span>
        <span className="muted-text processing-runs-model">{run.model}</span>
        <span className="muted-text">{time}</span>
        {typeof run.confidence === "number" ? (
          <span className="processing-runs-confidence">{Math.round(run.confidence * 100)}%</span>
        ) : null}
      </div>
      {inputSummary ? <div className="processing-runs-detail">{inputSummary}</div> : null}
      {(run.resultAnnotationIds?.length ?? 0) > 0 ? (
        <div className="processing-runs-detail">
          产出：
          {(run.resultAnnotationIds ?? []).map((id, index) => (
            <button
              key={id}
              type="button"
              className="processing-runs-result-id"
              onClick={() => onSelectAnnotation?.(id)}
              title={`跳到标注 ${id}`}
            >
              #{id.slice(-6)}
              {index < (run.resultAnnotationIds?.length ?? 0) - 1 ? "·" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {run.warning ? <div className="processing-runs-detail muted-text">⚠ {run.warning}</div> : null}
      {run.error ? <div className="processing-runs-detail processing-runs-error">✗ {run.error}</div> : null}
    </li>
  );
}

function formatInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const parts: string[] = [];
  if (typeof input.positiveCount === "number") {
    parts.push(`+${input.positiveCount}`);
  }
  if (typeof input.negativeCount === "number" && input.negativeCount > 0) {
    parts.push(`-${input.negativeCount}`);
  }
  if (input.hasBox === true) {
    parts.push("框");
  }
  if (typeof input.classFilter === "object" && input.classFilter !== null && Array.isArray(input.classFilter)) {
    const arr = input.classFilter as string[];
    if (arr.length > 0 && arr.length <= 3) {
      parts.push(arr.join(", "));
    } else if (arr.length > 3) {
      parts.push(`${arr.length} 类`);
    }
  }
  if (typeof input.confThreshold === "number") {
    parts.push(`阈值 ${input.confThreshold.toFixed(2)}`);
  }
  if (typeof input.path === "string") {
    parts.push(input.path === "source" ? "高清图" : "截图");
  }
  if (typeof input.sourceMode === "string") {
    parts.push(input.sourceMode);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatRelativeTime(iso: string): string {
  try {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    const delta = Date.now() - ts;
    if (delta < 60_000) return "刚刚";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}
