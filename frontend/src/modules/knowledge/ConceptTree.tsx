/**
 * 概念树导航（知识库工作区左栏）
 *
 * 参照系统的左栏：一级类目 → 二级分类 → 概念叶，每级带计数。
 * - 类目行显示该类概念数；概念行显示 "N 词 / M 段"
 * - 点类目 = 设为检索过滤；点概念 = 选中并在右栏展开详情
 * - 顶部统计条：Concept / Term / Segment / Source 总量
 */

import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import type { KbSnapshot } from "../../api/kb";
import { IconButton } from "../../ui/IconButton";

export type ConceptTreeProps = {
  snapshot: KbSnapshot;
  selectedConceptId?: string;
  activeCategoryId?: string;
  onSelectConcept: (id: string) => void;
  onSelectCategory: (id?: string) => void;
  onCreateConcept: (categoryId: string, subcategoryId?: string) => void;
};

export function ConceptTree({
  snapshot,
  selectedConceptId,
  activeCategoryId,
  onSelectConcept,
  onSelectCategory,
  onCreateConcept
}: ConceptTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const topCategories = useMemo(
    () => snapshot.categories.filter((c) => !c.parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [snapshot.categories]
  );
  const subcategoriesByParent = useMemo(() => {
    const map = new Map<string, typeof snapshot.categories>();
    for (const category of snapshot.categories) {
      if (!category.parentId) continue;
      const list = map.get(category.parentId) ?? [];
      list.push(category);
      map.set(category.parentId, list);
    }
    for (const list of map.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return map;
  }, [snapshot.categories]);

  const conceptStats = useMemo(() => {
    const termCount = new Map<string, number>();
    for (const term of snapshot.terms) {
      termCount.set(term.conceptId, (termCount.get(term.conceptId) ?? 0) + 1);
    }
    const segmentCount = new Map<string, number>();
    for (const segment of snapshot.segments) {
      for (const mention of segment.mentions) {
        segmentCount.set(mention.conceptId, (segmentCount.get(mention.conceptId) ?? 0) + 1);
      }
    }
    return { termCount, segmentCount };
  }, [snapshot.terms, snapshot.segments]);

  const conceptsByCategory = useMemo(() => {
    const map = new Map<string, typeof snapshot.concepts>();
    for (const concept of snapshot.concepts) {
      const key = concept.subcategoryId ?? concept.categoryId;
      const list = map.get(key) ?? [];
      list.push(concept);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label, "zh-Hans"));
    return map;
  }, [snapshot.concepts]);

  const countInCategory = (categoryId: string): number => {
    let count = conceptsByCategory.get(categoryId)?.length ?? 0;
    for (const sub of subcategoriesByParent.get(categoryId) ?? []) {
      count += conceptsByCategory.get(sub.id)?.length ?? 0;
    }
    return count;
  };

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderConcepts = (categoryId: string) =>
    (conceptsByCategory.get(categoryId) ?? []).map((concept) => (
      <li key={concept.id}>
        <button
          type="button"
          className={`kb-tree__concept${selectedConceptId === concept.id ? " is-selected" : ""}`}
          onClick={() => onSelectConcept(concept.id)}
        >
          <span className="kb-tree__concept-label">{concept.label}</span>
          <span className="kb-tree__concept-count">
            {conceptStats.termCount.get(concept.id) ?? 0} 词 / {conceptStats.segmentCount.get(concept.id) ?? 0} 段
          </span>
        </button>
      </li>
    ));

  return (
    <div className="kb-tree">
      <div className="kb-tree__stats">
        <span>
          <strong>{snapshot.concepts.length}</strong> Concept
        </span>
        <span>
          <strong>{snapshot.terms.length}</strong> Term
        </span>
        <span>
          <strong>{snapshot.segments.length}</strong> Segment
        </span>
        <span>
          <strong>{snapshot.sources.length}</strong> Source
        </span>
      </div>

      <ul className="kb-tree__list">
        <li>
          <button
            type="button"
            className={`kb-tree__category${!activeCategoryId ? " is-active" : ""}`}
            onClick={() => onSelectCategory(undefined)}
          >
            <span className="kb-tree__category-label">全部分类</span>
            <span className="kb-tree__category-count">{snapshot.concepts.length}</span>
          </button>
        </li>
        {topCategories.map((category) => {
          const isOpen = expanded.has(category.id);
          const subs = subcategoriesByParent.get(category.id) ?? [];
          return (
            <li key={category.id}>
              <div className={`kb-tree__category-row${activeCategoryId === category.id ? " is-active" : ""}`}>
                <button type="button" className="kb-tree__chevron" onClick={() => toggle(category.id)} aria-label="展开">
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <button
                  type="button"
                  className="kb-tree__category"
                  onClick={() => {
                    onSelectCategory(activeCategoryId === category.id ? undefined : category.id);
                    if (!isOpen) toggle(category.id);
                  }}
                >
                  <span className="kb-tree__category-dot" data-category={category.id} />
                  <span className="kb-tree__category-label">{category.name}</span>
                  <span className="kb-tree__category-count">{countInCategory(category.id)}</span>
                </button>
                <IconButton
                  size="sm"
                  label={`在「${category.name}」下新建概念`}
                  icon={<Plus size={12} />}
                  onClick={() => onCreateConcept(category.id)}
                />
              </div>
              {isOpen ? (
                <ul className="kb-tree__children">
                  {renderConcepts(category.id)}
                  {subs.map((sub) => {
                    const subOpen = expanded.has(sub.id);
                    const subConcepts = conceptsByCategory.get(sub.id) ?? [];
                    return (
                      <li key={sub.id}>
                        <div className={`kb-tree__category-row is-sub${activeCategoryId === sub.id ? " is-active" : ""}`}>
                          <button type="button" className="kb-tree__chevron" onClick={() => toggle(sub.id)} aria-label="展开">
                            {subOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </button>
                          <button
                            type="button"
                            className="kb-tree__category"
                            onClick={() => {
                              onSelectCategory(activeCategoryId === sub.id ? undefined : sub.id);
                              if (!subOpen) toggle(sub.id);
                            }}
                          >
                            <span className="kb-tree__category-label">{sub.name}</span>
                            <span className="kb-tree__category-count">{subConcepts.length}</span>
                          </button>
                          <IconButton
                            size="sm"
                            label={`在「${sub.name}」下新建概念`}
                            icon={<Plus size={12} />}
                            onClick={() => onCreateConcept(category.id, sub.id)}
                          />
                        </div>
                        {subOpen ? <ul className="kb-tree__children is-leaf">{renderConcepts(sub.id)}</ul> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
