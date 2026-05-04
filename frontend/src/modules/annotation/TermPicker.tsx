/**
 * 受控术语选择器 `TermPicker`
 *
 * 详情面板里的术语 chip 多选 + 自定义输入。从 `data/terms.json` 拉受控词表，
 * 用户可以：
 * - 输入关键字模糊搜索 → 下拉列出匹配项
 * - 点击建议添加 chip
 * - 删除 chip 移出 selection
 * - 输入新术语 → "自定义"按钮加入（scheme = WSC3D，role = custom）
 * - 接受 D6 共现推荐：根据全文档其他标注的术语共现频次，给出"建议"chip
 *
 * 数据流：
 * - 输入：value（已选 IimlTermRef[]）+ categories / terms（来自 fetchTerms）
 * - 输出：onChange(next IimlTermRef[]) 由父级写回 annotation.semantics.terms
 *
 * 设计要点：
 * - M2 阶段术语 scheme 固定为 WSC3D 本地词表；ICONCLASS / AAT / Wikidata 字段
 *   在类型上预留，UI 暂不暴露，留给 M3+ 接入
 * - 下拉列表点击外部自动关闭；点击 chip 删除按钮不冒泡到容器
 */

import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IimlTermRef, VocabularyCategory, VocabularyTerm } from "../../api/client";

type TermPickerProps = {
  value?: IimlTermRef[];
  categories: VocabularyCategory[];
  terms: VocabularyTerm[];
  // D6 共现推荐：基于全文档 annotation.terms 共现频次算出的"建议"术语；
  // 在搜索框下方显示一行 chip，点击直接加入。空数组 = 不显示推荐区
  suggestedTerms?: VocabularyTerm[];
  onChange: (next: IimlTermRef[]) => void;
};

// M2 阶段术语 scheme 固定为 WSC3D 本地词表，
// ICONCLASS / AAT / Wikidata 字段在类型上预留，UI 暂不暴露。
const WSC3D_SCHEME = "WSC3D";

export function TermPicker({ value, categories, terms, suggestedTerms = [], onChange }: TermPickerProps) {
  const selected = value ?? [];
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [addingCustom, setAddingCustom] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 分类 id → 分类名，便于在下拉建议里显示分类徽标。
  const categoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories) {
      map.set(category.id, category.name);
    }
    return map;
  }, [categories]);

  const selectedIds = useMemo(() => new Set(selected.map((term) => term.id)), [selected]);

  const suggestions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const pool = terms.filter((term) => !selectedIds.has(term.id));
    if (!trimmed) {
      return pool.slice(0, 30);
    }
    return pool
      .filter((term) => {
        if (term.prefLabel.toLowerCase().includes(trimmed)) {
          return true;
        }
        return term.altLabel.some((alt) => alt.toLowerCase().includes(trimmed));
      })
      .slice(0, 30);
  }, [query, terms, selectedIds]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleDown = (event: MouseEvent) => {
      if (!boxRef.current) {
        return;
      }
      if (!boxRef.current.contains(event.target as Node)) {
        setOpen(false);
        setAddingCustom(false);
      }
    };
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [open]);

  const pickExisting = (term: VocabularyTerm) => {
    const role = categoryNameById.get(term.broader[0] ?? "") ?? undefined;
    const next: IimlTermRef = {
      id: term.id,
      label: term.prefLabel,
      scheme: term.scheme || WSC3D_SCHEME,
      role
    };
    onChange([...selected, next]);
    setQuery("");
  };

  const addCustom = () => {
    const label = customDraft.trim();
    if (!label) {
      return;
    }
    const id = `custom:${slugify(label)}-${Date.now().toString(36)}`;
    onChange([...selected, { id, label, scheme: WSC3D_SCHEME }]);
    setCustomDraft("");
    setAddingCustom(false);
  };

  const removeAt = (id: string) => {
    onChange(selected.filter((term) => term.id !== id));
  };

  return (
    <div className="term-picker" ref={boxRef}>
      {selected.length > 0 ? (
        <ul className="term-chip-list">
          {selected.map((term) => (
            <li key={term.id} className="term-chip" title={term.role ? `${term.label} · ${term.role}` : term.label}>
              <span>{term.label}</span>
              {term.role ? <small>{term.role}</small> : null}
              <button type="button" className="term-chip-remove" aria-label="移除术语" onClick={() => removeAt(term.id)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="term-picker-search">
        <input
          type="search"
          placeholder={terms.length > 0 ? "搜索术语..." : "术语库未就绪"}
          value={query}
          disabled={terms.length === 0}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
        />
        <button
          type="button"
          className="term-picker-custom-toggle"
          title="自定义术语"
          onClick={() => {
            setAddingCustom((value) => !value);
            setOpen(true);
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* D6 共现推荐 chip 行：query 为空时显示；点击 chip 直接 pick */}
      {!query && suggestedTerms.length > 0 ? (
        <div className="term-picker-suggestions" role="group" aria-label="共现推荐">
          <span className="term-picker-suggestions-label">建议</span>
          {suggestedTerms.map((term) => {
            const groupName = categoryNameById.get(term.broader[0] ?? "");
            return (
              <button
                key={term.id}
                type="button"
                className="term-suggestion-chip"
                onClick={() => pickExisting(term)}
                title={groupName ? `${term.prefLabel} · ${groupName}（基于已有标注共现统计）` : `${term.prefLabel}（基于已有标注共现统计）`}
              >
                {term.prefLabel}
              </button>
            );
          })}
        </div>
      ) : null}

      {open && (suggestions.length > 0 || addingCustom) ? (
        <div className="term-picker-dropdown">
          {suggestions.length > 0 ? (
            <ul className="term-suggestion-list">
              {suggestions.map((term) => {
                const groupName = categoryNameById.get(term.broader[0] ?? "");
                return (
                  <li key={term.id}>
                    <button type="button" className="term-suggestion" onClick={() => pickExisting(term)}>
                      <span>{term.prefLabel}</span>
                      {groupName ? <small>{groupName}</small> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {addingCustom ? (
            <div className="term-custom-form">
              <input
                type="text"
                autoFocus
                placeholder="自定义术语名"
                value={customDraft}
                onChange={(event) => setCustomDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCustom();
                  }
                }}
              />
              <button type="button" className="primary-action small" onClick={addCustom} disabled={!customDraft.trim()}>
                添加
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "") || "term";
}
