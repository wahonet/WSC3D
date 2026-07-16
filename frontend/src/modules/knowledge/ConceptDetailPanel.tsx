/**
 * 概念详情面板（知识库工作区右栏）
 *
 * 对照参照系统的右栏详情卡：
 * - 概念卡：分类 / 概念类型 / 词形数 / 文段数 / 来源分布（出处 × 次数）
 * - 术语词形：chips 管理（添加异体词形 / 删除）
 * - 概念语义关系：带溯源（kind / confidence / method / 证据）+ 新建关系
 * - 独立共现：从文段提及自动派生（只读，权重 = 共现文段数）
 * - 提及文段：出处·页码 + 原文，点击跳文段详情
 */

import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createKbRelation,
  createKbTerm,
  deleteKbConcept,
  deleteKbRelation,
  deleteKbTerm,
  updateKbConcept,
  KB_CONCEPT_TYPE_LABELS,
  KB_CONFIDENCE_LABELS,
  KB_RELATION_KINDS,
  KB_RELATION_KIND_LABELS,
  type KbConceptDetail,
  type KbConceptType,
  type KbConfidence,
  type KbRelationKind,
  type KbSnapshot
} from "../../api/kb";
import { Button } from "../../ui/Button";
import { Field, Input, Select } from "../../ui/Field";
import { DraftInput, DraftTextarea } from "../annotation/DraftFields";
import { ConceptPicker } from "./ConceptPicker";

export type ConceptDetailPanelProps = {
  detail: KbConceptDetail;
  snapshot: KbSnapshot;
  onChanged: () => void;
  onSelectConcept: (id: string) => void;
  onOpenSegment: (id: string) => void;
  onStatus: (message: string) => void;
};

export function ConceptDetailPanel({ detail, snapshot, onChanged, onSelectConcept, onOpenSegment, onStatus }: ConceptDetailPanelProps) {
  const { concept } = detail;
  const [termDraft, setTermDraft] = useState("");
  const [relationKind, setRelationKind] = useState<KbRelationKind>("ASSOCIATED_WITH");
  const [relationConfidence, setRelationConfidence] = useState<KbConfidence>("unspecified");

  useEffect(() => {
    setTermDraft("");
  }, [concept.id]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      onChanged();
    } catch (error) {
      onStatus(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const subcategories = useMemo(
    () => snapshot.categories.filter((c) => c.parentId === concept.categoryId),
    [snapshot.categories, concept.categoryId]
  );

  return (
    <div className="kb-detail">
      <header className="kb-detail__header">
        <strong className="kb-detail__title">{concept.label}</strong>
        <span className="kb-detail__crumb">
          {detail.categoryName}
          {detail.subcategoryName ? ` · ${detail.subcategoryName}` : ""} · 语义关系 {detail.relations.length} · 共现{" "}
          {detail.cooccurrence.length}
        </span>
      </header>

      <dl className="kb-detail__meta">
        <dt>Concept ID</dt>
        <dd className="kb-detail__mono">{concept.id}</dd>
        <dt>概念类型</dt>
        <dd>
          <Select
            value={concept.conceptType}
            onChange={(e) => void run("修改概念类型", () => updateKbConcept(concept.id, { conceptType: e.target.value as KbConceptType }))}
          >
            {Object.entries(KB_CONCEPT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </dd>
        <dt>二级分类</dt>
        <dd>
          <Select
            value={concept.subcategoryId ?? ""}
            onChange={(e) => void run("修改二级分类", () => updateKbConcept(concept.id, { subcategoryId: e.target.value || undefined }))}
          >
            <option value="">（不设）</option>
            {subcategories.map((sub) => (
              <option key={sub.id} value={sub.id}>
                {sub.name}
              </option>
            ))}
          </Select>
        </dd>
        <dt>词形数</dt>
        <dd>{detail.terms.length}</dd>
        <dt>文段数</dt>
        <dd>{detail.segments.length}</dd>
        {detail.sourceDistribution.length > 0 ? (
          <>
            <dt>来源</dt>
            <dd>
              {detail.sourceDistribution.map((entry) => (
                <span key={entry.sourceId} className="kb-chip" title={entry.title}>
                  {entry.title} ×{entry.count}
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      <Field label="说明">
        <DraftTextarea
          value={concept.description ?? ""}
          placeholder="概念说明 / 界定…"
          rows={2}
          onCommit={(v) => void run("保存说明", () => updateKbConcept(concept.id, { description: v }))}
        />
      </Field>

      <section className="kb-detail__section">
        <header className="kb-detail__subheader">术语词形</header>
        <div className="kb-chip-row">
          {detail.terms.map((term) => (
            <span key={term.id} className={`kb-chip${term.form === concept.label ? " is-primary" : ""}`}>
              {term.form}
              {term.form !== concept.label ? (
                <button
                  type="button"
                  className="kb-chip__remove"
                  title="删除词形"
                  onClick={() => void run("删除词形", () => deleteKbTerm(term.id))}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
        <div className="kb-inline-form">
          <Input
            value={termDraft}
            placeholder="添加异体词形，如 丁蘭"
            onChange={(e) => setTermDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && termDraft.trim()) {
                e.preventDefault();
                void run("添加词形", () => createKbTerm({ form: termDraft, conceptId: concept.id })).then(() => setTermDraft(""));
              }
            }}
          />
          <Button
            compact
            disabled={!termDraft.trim()}
            onClick={() => void run("添加词形", () => createKbTerm({ form: termDraft, conceptId: concept.id })).then(() => setTermDraft(""))}
          >
            添加
          </Button>
        </div>
      </section>

      <section className="kb-detail__section">
        <header className="kb-detail__subheader">概念语义关系（{detail.relations.length}）</header>
        {detail.relations.length === 0 ? <p className="ui-muted">暂无语义关系。</p> : null}
        <ul className="kb-relation-list">
          {detail.relations.map((relation) => (
            <li key={relation.id} className="kb-relation">
              <div className="kb-relation__head">
                <span className="kb-relation__kind">{KB_RELATION_KIND_LABELS[relation.kind] ?? relation.kind}</span>
                <span className="kb-relation__direction">{relation.direction === "out" ? "本概念 →" : "← 本概念"}</span>
                <button type="button" className="kb-relation__target" onClick={() => onSelectConcept(relation.otherConceptId)}>
                  {relation.otherLabel}
                </button>
                <button
                  type="button"
                  className="kb-chip__remove"
                  title="删除关系"
                  onClick={() => void run("删除关系", () => deleteKbRelation(relation.id))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="kb-relation__prov">
                置信度 {KB_CONFIDENCE_LABELS[relation.confidence]} · {relation.method === "manual" ? "人工创建" : "自动"}
                {relation.evidenceSegmentIds?.length ? ` · 证据 ${relation.evidenceSegmentIds.length} 段` : ""}
                {relation.note ? ` · ${relation.note}` : ""}
              </div>
            </li>
          ))}
        </ul>
        <div className="kb-relation-add">
          <Select value={relationKind} onChange={(e) => setRelationKind(e.target.value as KbRelationKind)}>
            {KB_RELATION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KB_RELATION_KIND_LABELS[kind]}
              </option>
            ))}
          </Select>
          <Select value={relationConfidence} onChange={(e) => setRelationConfidence(e.target.value as KbConfidence)}>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="unspecified">未定</option>
          </Select>
          <ConceptPicker
            concepts={snapshot.concepts}
            categories={snapshot.categories}
            placeholder="目标概念…"
            excludeIds={[concept.id]}
            onPick={(target) =>
              void run("创建关系", () =>
                createKbRelation({
                  kind: relationKind,
                  sourceConceptId: concept.id,
                  targetConceptId: target.id,
                  confidence: relationConfidence
                })
              )
            }
          />
        </div>
      </section>

      {detail.cooccurrence.length > 0 ? (
        <section className="kb-detail__section">
          <header className="kb-detail__subheader">独立共现（同文段，自动派生）</header>
          <div className="kb-chip-row">
            {detail.cooccurrence.map((edge) => (
              <button
                key={edge.conceptId}
                type="button"
                className="kb-chip is-clickable"
                title={`共现 ${edge.weight} 段`}
                onClick={() => onSelectConcept(edge.conceptId)}
              >
                {edge.label} ×{edge.weight}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="kb-detail__section">
        <header className="kb-detail__subheader">提及文段（{detail.segments.length}）</header>
        {detail.segments.length === 0 ? <p className="ui-muted">尚无文段提及该概念；在「文献与文段」里录入。</p> : null}
        <ul className="kb-segment-list">
          {detail.segments.map((segment) => (
            <li key={segment.id}>
              <button type="button" className="kb-segment-item" onClick={() => onOpenSegment(segment.id)}>
                <span className="kb-segment-item__source">
                  {segment.sourceTitle}
                  {segment.page ? ` · 页 ${segment.page}` : ""}
                </span>
                <span className="kb-segment-item__text">{segment.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="kb-detail__section kb-detail__danger">
        <Button
          compact
          variant="danger"
          onClick={() => {
            if (window.confirm(`删除概念「${concept.label}」？其词形、关系与文段提及会一并清除。`)) {
              void run("删除概念", () => deleteKbConcept(concept.id));
            }
          }}
        >
          <Trash2 size={13} /> 删除概念
        </Button>
      </section>
    </div>
  );
}

export type ConceptCreateFormProps = {
  snapshot: KbSnapshot;
  presetCategoryId?: string;
  presetSubcategoryId?: string;
  onCreated: (conceptId: string) => void;
  onCancel: () => void;
  onStatus: (message: string) => void;
};

export function ConceptCreateForm({ snapshot, presetCategoryId, presetSubcategoryId, onCreated, onCancel, onStatus }: ConceptCreateFormProps) {
  const topCategories = snapshot.categories.filter((c) => !c.parentId);
  const [label, setLabel] = useState("");
  const [categoryId, setCategoryId] = useState(presetCategoryId ?? topCategories[0]?.id ?? "");
  const [subcategoryId, setSubcategoryId] = useState(presetSubcategoryId ?? "");
  const [conceptType, setConceptType] = useState<KbConceptType>("entity");
  const subcategories = snapshot.categories.filter((c) => c.parentId === categoryId);

  return (
    <div className="kb-detail">
      <header className="kb-detail__header">
        <strong className="kb-detail__title">新建概念</strong>
      </header>
      <Field label="规范名（首选词形）">
        <Input value={label} placeholder="如：荆轲刺秦王" autoFocus onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="一级类目">
        <Select
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setSubcategoryId("");
          }}
        >
          {topCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="二级分类">
        <Select value={subcategoryId} onChange={(e) => setSubcategoryId(e.target.value)}>
          <option value="">（不设）</option>
          {subcategories.map((sub) => (
            <option key={sub.id} value={sub.id}>
              {sub.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="概念类型">
        <Select value={conceptType} onChange={(e) => setConceptType(e.target.value as KbConceptType)}>
          {Object.entries(KB_CONCEPT_TYPE_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
      </Field>
      <div className="kb-inline-form">
        <Button
          variant="primary"
          disabled={!label.trim()}
          onClick={() => {
            void (async () => {
              try {
                const { createKbConcept } = await import("../../api/kb");
                const concept = await createKbConcept({
                  label,
                  categoryId,
                  subcategoryId: subcategoryId || undefined,
                  conceptType
                });
                onCreated(concept.id);
              } catch (error) {
                onStatus(`新建概念失败：${error instanceof Error ? error.message : String(error)}`);
              }
            })();
          }}
        >
          创建
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}
