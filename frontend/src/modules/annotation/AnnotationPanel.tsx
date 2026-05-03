import { Bot, Download, FileText, GitBranch, Network, ScanSearch, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type React from "react";
import type { AnnotationFilter, AnnotationTab, IimlAnnotation, IimlDocument, IimlReviewStatus, IimlStructuralLevel, VocabularyTerm } from "./types";

type AnnotationPanelProps = {
  doc?: IimlDocument;
  terms: VocabularyTerm[];
  selectedAnnotation?: IimlAnnotation;
  activeTab: AnnotationTab;
  filter: AnnotationFilter;
  status?: string;
  aiBusy?: "sam" | "yolo" | "canny";
  aiAvailable: boolean;
  onTabChange: (tab: AnnotationTab) => void;
  onFilterChange: (filter: AnnotationFilter) => void;
  onSelectAnnotation: (id?: string) => void;
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
  onImportMarkdown: () => void;
  onExport: () => void;
  onRunYolo: () => void;
  onRunCanny: () => void;
};

const tabs: Array<{ id: AnnotationTab; label: string; icon: React.ReactNode }> = [
  { id: "object", label: "对象", icon: <FileText size={14} /> },
  { id: "terms", label: "术语表", icon: <Search size={14} /> },
  { id: "annotations", label: "我的标注", icon: <Sparkles size={14} /> },
  { id: "graph", label: "知识图谱", icon: <Network size={14} /> },
  { id: "history", label: "历史", icon: <GitBranch size={14} /> }
];

const structuralLabels: Record<IimlStructuralLevel, string> = {
  whole: "整体",
  scene: "场景",
  figure: "人物 / 对象",
  component: "部件",
  trace: "刻痕 / 线迹",
  inscription: "题刻",
  damage: "病害",
  unknown: "未定"
};

const reviewLabels: Record<IimlReviewStatus, string> = {
  candidate: "候选",
  reviewed: "已复核",
  approved: "通过",
  rejected: "拒绝"
};

export function AnnotationPanel({
  doc,
  terms,
  selectedAnnotation,
  activeTab,
  filter,
  status,
  aiBusy,
  aiAvailable,
  onTabChange,
  onFilterChange,
  onSelectAnnotation,
  onUpdateAnnotation,
  onImportMarkdown,
  onExport,
  onRunYolo,
  onRunCanny
}: AnnotationPanelProps) {
  return (
    <>
      <section className="panel-section annotation-status-panel">
        <div className="section-title">标注</div>
        <div className="annotation-actions">
          <button className="secondary-action" onClick={onImportMarkdown}>
            <FileText size={15} />
            导入档案骨架
          </button>
          <button className="secondary-action" onClick={onExport} disabled={!doc}>
            <Download size={15} />
            导出 IIML
          </button>
        </div>
        <div className="annotation-actions">
          <button className="secondary-action" onClick={onRunYolo} disabled={!aiAvailable || aiBusy !== undefined}>
            <ScanSearch size={15} />
            YOLO 扫描
          </button>
          <button className="secondary-action" onClick={onRunCanny} disabled={!aiAvailable || aiBusy !== undefined}>
            <Bot size={15} />
            快速线图
          </button>
        </div>
        <p className="muted-text">{status ?? (aiAvailable ? "AI 服务已连接" : "AI 服务未连接，手工标注可继续使用")}</p>
      </section>

      <section className="panel-section annotation-tabs-panel">
        <div className="annotation-tabs">
          {tabs.map((tab) => (
            <button className={activeTab === tab.id ? "active" : ""} key={tab.id} onClick={() => onTabChange(tab.id)}>
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        {activeTab === "object" ? (
          <ObjectEditor annotation={selectedAnnotation} terms={terms} onUpdate={onUpdateAnnotation} />
        ) : activeTab === "terms" ? (
          <TermBrowser terms={terms} selectedAnnotation={selectedAnnotation} onUpdate={onUpdateAnnotation} />
        ) : activeTab === "annotations" ? (
          <AnnotationList doc={doc} filter={filter} selectedAnnotationId={selectedAnnotation?.id} onFilterChange={onFilterChange} onSelect={onSelectAnnotation} />
        ) : activeTab === "graph" ? (
          <p className="muted-text">知识图谱将在 M3 接入 Cytoscape.js。当前 M1 已保留 relations 字段。</p>
        ) : (
          <p className="muted-text">类 Git 历史将在 M3 接入。当前 M1 已提供撤销/重做和 IIML 导出。</p>
        )}
      </section>
    </>
  );
}

function ObjectEditor({
  annotation,
  terms,
  onUpdate
}: {
  annotation?: IimlAnnotation;
  terms: VocabularyTerm[];
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
}) {
  if (!annotation) {
    return <p className="muted-text">请选择或新建一个标注。</p>;
  }

  const updateSemantics = (patch: NonNullable<IimlAnnotation["semantics"]>) => {
    onUpdate(annotation.id, { semantics: { ...(annotation.semantics ?? {}), ...patch } });
  };

  return (
    <div className="annotation-editor">
      <label>
        <span>标签</span>
        <input value={annotation.label ?? ""} onChange={(event) => onUpdate(annotation.id, { label: event.target.value })} />
      </label>
      <label>
        <span>结构层级</span>
        <select value={annotation.structuralLevel} onChange={(event) => onUpdate(annotation.id, { structuralLevel: event.target.value as IimlStructuralLevel })}>
          {Object.entries(structuralLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>前图像志 / 对象识别</span>
        <textarea value={annotation.semantics?.iconographicMeaning ?? ""} onChange={(event) => updateSemantics({ iconographicMeaning: event.target.value })} />
      </label>
      <label>
        <span>图像学解释</span>
        <textarea value={annotation.semantics?.iconologicalMeaning ?? ""} onChange={(event) => updateSemantics({ iconologicalMeaning: event.target.value })} />
      </label>
      <label>
        <span>题刻释文</span>
        <input
          value={annotation.semantics?.inscription?.transcription ?? ""}
          onChange={(event) =>
            updateSemantics({ inscription: { ...(annotation.semantics?.inscription ?? {}), transcription: event.target.value } })
          }
        />
      </label>
      <label>
        <span>备注</span>
        <textarea value={annotation.notes ?? ""} onChange={(event) => onUpdate(annotation.id, { notes: event.target.value })} />
      </label>
      <label>
        <span>审核状态</span>
        <select value={annotation.reviewStatus ?? "reviewed"} onChange={(event) => onUpdate(annotation.id, { reviewStatus: event.target.value as IimlReviewStatus })}>
          {Object.entries(reviewLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="review-actions">
        <button onClick={() => onUpdate(annotation.id, { reviewStatus: "approved" })}>通过</button>
        <button onClick={() => onUpdate(annotation.id, { reviewStatus: "reviewed" })}>需修改</button>
        <button onClick={() => onUpdate(annotation.id, { reviewStatus: "rejected" })}>拒绝</button>
      </div>
      <p className="muted-text">已绑定术语：{annotation.semantics?.terms?.map((term) => term.label).join("、") || "无"}（术语表共 {terms.length} 项）</p>
    </div>
  );
}

function TermBrowser({
  terms,
  selectedAnnotation,
  onUpdate
}: {
  terms: VocabularyTerm[];
  selectedAnnotation?: IimlAnnotation;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => terms.filter((term) => term.prefLabel.includes(query) || term.id.includes(query)), [query, terms]);
  const selectedTerms = selectedAnnotation?.semantics?.terms ?? [];
  return (
    <div className="term-browser">
      <input placeholder="搜索术语" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="term-list">
        {filtered.map((term) => {
          const checked = selectedTerms.some((item) => item.id === term.id);
          return (
            <button
              className={checked ? "active" : ""}
              disabled={!selectedAnnotation}
              key={term.id}
              onClick={() => {
                if (!selectedAnnotation) {
                  return;
                }
                const nextTerms = checked
                  ? selectedTerms.filter((item) => item.id !== term.id)
                  : [...selectedTerms, { id: term.id, label: term.prefLabel, scheme: term.scheme, role: "iconographic" }];
                onUpdate(selectedAnnotation.id, { semantics: { ...(selectedAnnotation.semantics ?? {}), terms: nextTerms } });
              }}
            >
              {term.prefLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AnnotationList({
  doc,
  filter,
  selectedAnnotationId,
  onFilterChange,
  onSelect
}: {
  doc?: IimlDocument;
  filter: AnnotationFilter;
  selectedAnnotationId?: string;
  onFilterChange: (filter: AnnotationFilter) => void;
  onSelect: (id?: string) => void;
}) {
  const annotations = (doc?.annotations ?? []).filter((annotation) => {
    if (filter === "candidate") {
      return annotation.reviewStatus === "candidate";
    }
    if (filter === "approved") {
      return annotation.reviewStatus === "approved" || annotation.reviewStatus === "reviewed";
    }
    return true;
  });

  return (
    <div className="annotation-list-panel">
      <div className="segmented compact">
        {(["all", "candidate", "approved"] as AnnotationFilter[]).map((item) => (
          <button className={filter === item ? "active" : ""} key={item} onClick={() => onFilterChange(item)}>
            {item === "all" ? "全部" : item === "candidate" ? "候选" : "已确认"}
          </button>
        ))}
      </div>
      <div className="annotation-list">
        {annotations.map((annotation) => (
          <button className={annotation.id === selectedAnnotationId ? "active" : ""} key={annotation.id} onClick={() => onSelect(annotation.id)}>
            <strong>{annotation.label || annotation.id}</strong>
            <span>{reviewLabels[annotation.reviewStatus ?? "reviewed"]} · {structuralLabels[annotation.structuralLevel]}</span>
          </button>
        ))}
        {annotations.length === 0 ? <p className="muted-text">暂无标注。</p> : null}
      </div>
    </div>
  );
}
