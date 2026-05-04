import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { IimlAnnotation, IimlRelation } from "./types";

// F1：多解释并存 UI 专项
//
// 论文 35 ICON 框架强调"多解释并存"是数字研究档案的核心需求 —— 同一画面
// 形象（比如某只兽）可能被 A 学者读作"青龙"、B 学者读作"独角兽"、C 学者
// 读作"应龙"。IIML schema 通过 `alternativeInterpretationOf` 关系类型支持
// 这种多视角，但 v0.6.0 只能在关系列表里看到 "alt" 标签，没有专门的"多视角
// 对比"展示。
//
// 这个组件挂在 EditTab 里 RelationsEditor 之上：
// - 检测当前 annotation 是否有 `alternativeInterpretationOf` 关系（双向）
// - 把所有相关解释（包括当前标注）并排列出
// - 每个解释显示：标签 / 三层语义 / generation 来源（人工/SAM/YOLO）/ 置信度
//   / 简短证据源摘要
// - 用户可以一眼看清各解释之间的差异 + 各自的证据强度
//
// 视觉：默认折叠以避免占空间；展开后为横向滚动卡片，最多并排 3 张（超出滚动）

export type AlternativeInterpretationsViewProps = {
  annotation: IimlAnnotation;
  annotations: IimlAnnotation[];
  relations: IimlRelation[];
  onSelectAnnotation: (id: string) => void;
};

const generationMethodLabels: Record<string, string> = {
  manual: "手动",
  sam: "SAM",
  yolo: "YOLO",
  "sam-refine": "SAM 精修",
  canny: "Canny"
};

export function AlternativeInterpretationsView({
  annotation,
  annotations,
  relations,
  onSelectAnnotation
}: AlternativeInterpretationsViewProps) {
  const [open, setOpen] = useState(false);

  // 收集与当前 annotation 通过 alternativeInterpretationOf 相关的所有 annotation id
  // 关系是双向的：A alt B 等价于 B alt A，所以两端都要看
  const relatedIds = useMemo(() => {
    const set = new Set<string>();
    for (const relation of relations) {
      if (relation.kind !== "alternativeInterpretationOf") continue;
      if (relation.source === annotation.id) set.add(relation.target);
      if (relation.target === annotation.id) set.add(relation.source);
    }
    return set;
  }, [annotation.id, relations]);

  // 拿到所有相关 annotation 的实体；过滤掉已经不存在的（关系悬空）
  const relatedAnnotations = useMemo(() => {
    if (relatedIds.size === 0) return [];
    return annotations.filter((a) => relatedIds.has(a.id));
  }, [annotations, relatedIds]);

  if (relatedAnnotations.length === 0) {
    return null;
  }

  // 当前 annotation 自己也作为 "view 0" 并入对比，方便横向看差异
  const allViews = [annotation, ...relatedAnnotations];

  return (
    <section className="alt-interpretations">
      <button
        type="button"
        className="alt-interpretations-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Sparkles size={13} />
        <span className="alt-interpretations-title">多视角解释</span>
        <span className="alt-interpretations-count">{allViews.length} 种</span>
      </button>
      {open ? (
        <div className="alt-interpretations-body">
          <p className="alt-interpretations-hint">
            同一区域被多位研究者读出不同含义；并排对比标签 / 三层语义 / 来源，
            判断哪种解释更可信。点击卡片头跳转到对应标注。
          </p>
          <div className="alt-interpretations-grid">
            {allViews.map((view) => {
              const isCurrent = view.id === annotation.id;
              const method = view.generation?.method ?? "manual";
              const methodLabel = generationMethodLabels[method] ?? method;
              const confidence = view.generation?.confidence;
              const sources = view.sources ?? [];
              return (
                <article
                  key={view.id}
                  className={
                    "alt-interpretations-card" + (isCurrent ? " is-current" : "")
                  }
                >
                  <header className="alt-interpretations-card-head">
                    <button
                      type="button"
                      className="alt-interpretations-card-title"
                      onClick={() => onSelectAnnotation(view.id)}
                      title={isCurrent ? "当前正在看的标注" : "点击在画布上选中此解释"}
                    >
                      {view.label || "未命名"}
                      {isCurrent ? <span className="alt-interpretations-current-badge">当前</span> : null}
                    </button>
                    <span
                      className="alt-interpretations-card-color"
                      style={{ background: view.color ?? "#6f6a62" }}
                      aria-hidden
                    />
                  </header>
                  <div className="alt-interpretations-card-meta">
                    <span className="alt-interpretations-meta-chip" title="生成来源">
                      {methodLabel}
                    </span>
                    {typeof confidence === "number" ? (
                      <span className="alt-interpretations-meta-chip" title="置信度">
                        {Math.round(confidence * 100)}%
                      </span>
                    ) : null}
                    {sources.length > 0 ? (
                      <span className="alt-interpretations-meta-chip" title="证据源数量">
                        证据 {sources.length}
                      </span>
                    ) : null}
                  </div>
                  <SemanticsBlock annotation={view} />
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SemanticsBlock({ annotation }: { annotation: IimlAnnotation }) {
  const semantics = annotation.semantics ?? {};
  const rows: Array<{ label: string; value?: string }> = [
    { label: "前图像志", value: semantics.preIconographic },
    { label: "图像志", value: semantics.iconographicMeaning },
    { label: "图像学", value: semantics.iconologicalMeaning }
  ];
  const inscription = semantics.inscription;
  if (inscription?.transcription || inscription?.translation) {
    rows.push({
      label: "题刻",
      value: [inscription.transcription, inscription.translation].filter(Boolean).join(" / ")
    });
  }
  if (annotation.notes) {
    rows.push({ label: "备注", value: annotation.notes });
  }
  return (
    <dl className="alt-interpretations-semantics">
      {rows.map((row) => (
        <div key={row.label} className="alt-interpretations-semantics-row">
          <dt>{row.label}</dt>
          <dd>{row.value || <span className="muted-text">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
