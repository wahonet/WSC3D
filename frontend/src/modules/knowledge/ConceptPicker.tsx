/**
 * 概念选择器（搜索 + 下拉）。
 *
 * 知识库工作区（关系目标、文段提及）与标注工作区（Phase 4 概念绑定）共用：
 * 输入关键字 → 概念列表（带分类徽标）→ 点击选中。数据源支持两种：
 * - 传入 concepts（知识库工作区已有快照）
 * - 不传则按需拉 /api/kb/snapshot 的概念子集（标注侧轻量使用）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchKbSnapshot, type KbCategory, type KbConcept } from "../../api/kb";

export type ConceptPickerProps = {
  concepts?: KbConcept[];
  categories?: KbCategory[];
  placeholder?: string;
  excludeIds?: string[];
  onPick: (concept: KbConcept) => void;
};

export function ConceptPicker({ concepts, categories, placeholder = "搜索概念…", excludeIds = [], onPick }: ConceptPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{ concepts: KbConcept[]; categories: KbCategory[] }>();
  const boxRef = useRef<HTMLDivElement | null>(null);

  const effectiveConcepts = concepts ?? loaded?.concepts ?? [];
  const effectiveCategories = categories ?? loaded?.categories ?? [];

  useEffect(() => {
    if (concepts || loaded) return;
    if (!open) return;
    let cancelled = false;
    fetchKbSnapshot()
      .then((snapshot) => {
        if (!cancelled) setLoaded({ concepts: snapshot.concepts, categories: snapshot.categories });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ concepts: [], categories: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [concepts, loaded, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const categoryName = useMemo(() => {
    const map = new Map(effectiveCategories.map((c) => [c.id, c.name]));
    return (concept: KbConcept) => map.get(concept.subcategoryId ?? concept.categoryId) ?? map.get(concept.categoryId) ?? "";
  }, [effectiveCategories]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const excluded = new Set(excludeIds);
    const pool = effectiveConcepts.filter((c) => !excluded.has(c.id));
    const hits = q ? pool.filter((c) => c.label.toLowerCase().includes(q)) : pool;
    return hits.slice(0, 30);
  }, [effectiveConcepts, excludeIds, query]);

  return (
    <div className="kb-concept-picker" ref={boxRef}>
      <input
        type="search"
        className="ui-input"
        placeholder={placeholder}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {open && matches.length > 0 ? (
        <ul className="kb-concept-picker__dropdown">
          {matches.map((concept) => (
            <li key={concept.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(concept);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span>{concept.label}</span>
                <small>{categoryName(concept)}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open && matches.length === 0 && query.trim() ? (
        <div className="kb-concept-picker__dropdown kb-concept-picker__empty">无匹配概念</div>
      ) : null}
    </div>
  );
}
