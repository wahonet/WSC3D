import { Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  IimlAnnotation,
  IimlRelation,
  IimlRelationKind,
  IimlRelationOrigin
} from "./types";

// 受控关系词表：覆盖论文 35 ICON 提示的"叙事关系 + 层级关系 + 解释并存"。
// 空间关系（above / below 等）由 B2 自动推导出 origin="spatial-auto"，用户在
// UI 上"采纳"才升为 manual 落入 IIML，否则不写入文档。
export const relationKindOptions: Array<{
  value: IimlRelationKind;
  label: string;
  group: "narrative" | "hierarchy" | "spatial" | "interpret";
}> = [
  { value: "holds", label: "持（holds）", group: "narrative" },
  { value: "rides", label: "乘（rides）", group: "narrative" },
  { value: "attacks", label: "攻击（attacks）", group: "narrative" },
  { value: "faces", label: "面对（faces）", group: "narrative" },
  { value: "partOf", label: "属于（partOf）", group: "hierarchy" },
  { value: "contains", label: "包含（contains）", group: "hierarchy" },
  { value: "nextTo", label: "相邻（nextTo）", group: "spatial" },
  { value: "above", label: "在上（above）", group: "spatial" },
  { value: "below", label: "在下（below）", group: "spatial" },
  { value: "leftOf", label: "在左（leftOf）", group: "spatial" },
  { value: "rightOf", label: "在右（rightOf）", group: "spatial" },
  { value: "overlaps", label: "重叠（overlaps）", group: "spatial" },
  { value: "alternativeInterpretationOf", label: "另释（alternative）", group: "interpret" },
  { value: "manual", label: "其他（manual）", group: "interpret" }
];

const groupLabels: Record<"narrative" | "hierarchy" | "spatial" | "interpret", string> = {
  narrative: "叙事",
  hierarchy: "层级",
  spatial: "空间",
  interpret: "解释"
};

export type SpatialRelationCandidate = {
  id: string;
  kind: IimlRelationKind;
  source: string;
  target: string;
  origin: "spatial-auto";
};

type RelationsEditorProps = {
  // 当前选中的标注 —— 该 section 显示与该标注相关的关系
  annotation: IimlAnnotation;
  // 文档中已存的全部关系（通过 store.getRelations 取出，已过滤无效条目）
  relations: IimlRelation[];
  // 文档中所有标注（用来做对方下拉 + 在关系条目里显示对方 label）
  annotations: IimlAnnotation[];
  // B2 推导出的空间关系候选；用户点"采纳"会通过 onAddRelation 升级为 manual
  spatialCandidates?: SpatialRelationCandidate[];
  onAddRelation: (relation: IimlRelation) => void;
  onUpdateRelation: (id: string, patch: Partial<IimlRelation>) => void;
  onDeleteRelation: (id: string) => void;
  // 点关系条目跳到对方标注（让画布 / panel 选中）
  onSelectAnnotation: (id: string) => void;
};

/**
 * 标注间关系编辑面板：展示当前选中标注作为 source / target 的全部已存关系，
 * 提供 inline 添加表单 + 单条删除。空间关系自动推导（B2）的候选用 ghost
 * 风格列在底部，可一键"采纳"为 manual 关系。
 */
export function RelationsEditor({
  annotation,
  relations,
  annotations,
  spatialCandidates = [],
  onAddRelation,
  onUpdateRelation: _onUpdateRelation,
  onDeleteRelation,
  onSelectAnnotation
}: RelationsEditorProps) {
  const [adding, setAdding] = useState(false);
  const [draftKind, setDraftKind] = useState<IimlRelationKind>("partOf");
  const [draftTarget, setDraftTarget] = useState<string>("");
  const [draftNote, setDraftNote] = useState("");

  useEffect(() => {
    // 切换标注时收起表单，避免上一标注的 draft 串到新标注。
    setAdding(false);
    setDraftKind("partOf");
    setDraftTarget("");
    setDraftNote("");
  }, [annotation.id]);

  // 标注 id → label/简要 的查找表，用于在关系条目里显示对方
  const labelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of annotations) {
      map.set(item.id, item.label && item.label.trim() ? item.label : `未命名（${item.id.slice(-6)}）`);
    }
    return map;
  }, [annotations]);

  const outgoing = useMemo(
    () => relations.filter((relation) => relation.source === annotation.id),
    [annotation.id, relations]
  );
  const incoming = useMemo(
    () => relations.filter((relation) => relation.target === annotation.id),
    [annotation.id, relations]
  );

  // 已存关系不再作为"待采纳"显示（避免重复）
  const filteredCandidates = useMemo(() => {
    return spatialCandidates.filter((candidate) => {
      return !relations.some(
        (relation) =>
          relation.source === candidate.source &&
          relation.target === candidate.target &&
          relation.kind === candidate.kind
      );
    });
  }, [relations, spatialCandidates]);

  const otherAnnotations = useMemo(
    () => annotations.filter((item) => item.id !== annotation.id),
    [annotation.id, annotations]
  );

  // 表单首次打开时自动选第一个有效目标
  useEffect(() => {
    if (adding && !draftTarget && otherAnnotations.length > 0) {
      setDraftTarget(otherAnnotations[0].id);
    }
  }, [adding, draftTarget, otherAnnotations]);

  const submit = () => {
    if (!draftTarget) {
      return;
    }
    const now = new Date().toISOString();
    onAddRelation({
      id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: draftKind,
      source: annotation.id,
      target: draftTarget,
      note: draftNote.trim() || undefined,
      origin: "manual",
      createdAt: now,
      createdBy: "local-user",
      updatedAt: now
    });
    setAdding(false);
    setDraftKind("partOf");
    setDraftTarget("");
    setDraftNote("");
  };

  const adoptCandidate = (candidate: SpatialRelationCandidate) => {
    const now = new Date().toISOString();
    onAddRelation({
      id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: candidate.kind,
      source: candidate.source,
      target: candidate.target,
      note: undefined,
      origin: "manual",
      createdAt: now,
      createdBy: "local-user",
      updatedAt: now
    });
  };

  return (
    <div className="relations-editor">
      <div className="relations-editor-head">
        <span className="relations-editor-title">关系</span>
        <span className="muted-text">
          作为来源 {outgoing.length} · 作为目标 {incoming.length}
        </span>
        {!adding ? (
          <button
            type="button"
            className="ghost-link"
            onClick={() => setAdding(true)}
            disabled={otherAnnotations.length === 0}
          >
            + 添加
          </button>
        ) : null}
      </div>

      {outgoing.length === 0 && incoming.length === 0 && filteredCandidates.length === 0 ? (
        <p className="muted-text relations-editor-empty">
          {otherAnnotations.length === 0 ? "至少需要 2 个标注才能建立关系。" : "尚未建立任何关系。"}
        </p>
      ) : null}

      {outgoing.length > 0 ? (
        <ul className="relations-list">
          {outgoing.map((relation) => (
            <li key={relation.id} className="relations-item">
              <span className="relations-item-arrow">→</span>
              <button
                type="button"
                className="relations-item-target"
                onClick={() => onSelectAnnotation(relation.target)}
                title="跳转到目标标注"
              >
                {labelMap.get(relation.target) ?? `已删（${relation.target.slice(-6)}）`}
              </button>
              <span className="relations-item-kind">{kindLabel(relation.kind)}</span>
              {relation.origin === "spatial-auto" ? (
                <span className="relations-item-origin">自动</span>
              ) : null}
              <button
                type="button"
                className="mini-icon danger"
                title="删除关系"
                onClick={() => onDeleteRelation(relation.id)}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {incoming.length > 0 ? (
        <ul className="relations-list relations-list--incoming">
          {incoming.map((relation) => (
            <li key={relation.id} className="relations-item">
              <span className="relations-item-arrow">←</span>
              <button
                type="button"
                className="relations-item-target"
                onClick={() => onSelectAnnotation(relation.source)}
                title="跳转到来源标注"
              >
                {labelMap.get(relation.source) ?? `已删（${relation.source.slice(-6)}）`}
              </button>
              <span className="relations-item-kind">{kindLabel(relation.kind)}</span>
              {relation.origin === "spatial-auto" ? (
                <span className="relations-item-origin">自动</span>
              ) : null}
              <button
                type="button"
                className="mini-icon danger"
                title="删除关系"
                onClick={() => onDeleteRelation(relation.id)}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <div className="relations-form">
          <div className="relations-form-row">
            <label className="relations-form-label">关系</label>
            <select
              className="relations-form-select"
              value={draftKind}
              onChange={(event) => setDraftKind(event.target.value as IimlRelationKind)}
            >
              {(Object.keys(groupLabels) as Array<keyof typeof groupLabels>).map((group) => (
                <optgroup key={group} label={groupLabels[group]}>
                  {relationKindOptions
                    .filter((option) => option.group === group)
                    .map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="relations-form-row">
            <label className="relations-form-label">目标</label>
            <select
              className="relations-form-select"
              value={draftTarget}
              onChange={(event) => setDraftTarget(event.target.value)}
            >
              {otherAnnotations.map((item) => (
                <option key={item.id} value={item.id}>
                  {labelMap.get(item.id) ?? item.id}
                </option>
              ))}
            </select>
          </div>
          <div className="relations-form-row">
            <label className="relations-form-label">备注</label>
            <input
              className="relations-form-input"
              type="text"
              placeholder="可选"
              value={draftNote}
              onChange={(event) => setDraftNote(event.target.value)}
            />
          </div>
          <div className="relations-form-actions">
            <button type="button" className="ghost-link" onClick={() => setAdding(false)}>
              取消
            </button>
            <button type="button" className="primary-action small" onClick={submit} disabled={!draftTarget}>
              保存
            </button>
          </div>
        </div>
      ) : null}

      {filteredCandidates.length > 0 ? (
        <div className="relations-candidates">
          <div className="relations-candidates-head">
            <span>空间关系自动推导</span>
            <span className="muted-text">点"采纳"升级为正式关系</span>
          </div>
          <ul className="relations-list">
            {filteredCandidates.map((candidate) => {
              const arrow = candidate.source === annotation.id ? "→" : "←";
              const otherId = candidate.source === annotation.id ? candidate.target : candidate.source;
              return (
                <li key={candidate.id} className="relations-item is-candidate">
                  <span className="relations-item-arrow">{arrow}</span>
                  <button
                    type="button"
                    className="relations-item-target"
                    onClick={() => onSelectAnnotation(otherId)}
                    title="跳转到对方标注"
                  >
                    {labelMap.get(otherId) ?? `（${otherId.slice(-6)}）`}
                  </button>
                  <span className="relations-item-kind">{kindLabel(candidate.kind)}</span>
                  <span className="relations-item-origin">推导</span>
                  <button
                    type="button"
                    className="ghost-link"
                    onClick={() => adoptCandidate(candidate)}
                    title="把推导关系升级为 manual 写入 IIML"
                  >
                    采纳
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function kindLabel(kind: IimlRelationKind): string {
  return relationKindOptions.find((option) => option.value === kind)?.label ?? kind;
}

// 工具函数：构造一个新的 manual 关系；外部（如画布连线 popover）若需要直接
// 创建关系也走这个出口。
export function createManualRelation(
  kind: IimlRelationKind,
  source: string,
  target: string,
  options: { note?: string; origin?: IimlRelationOrigin } = {}
): IimlRelation {
  const now = new Date().toISOString();
  return {
    id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    source,
    target,
    note: options.note,
    origin: options.origin ?? "manual",
    createdAt: now,
    createdBy: "local-user",
    updatedAt: now
  };
}
