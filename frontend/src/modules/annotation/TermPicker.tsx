import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IimlTermRef, VocabularyCategory, VocabularyTerm } from "../../api/client";

type TermPickerProps = {
  value?: IimlTermRef[];
  categories: VocabularyCategory[];
  terms: VocabularyTerm[];
  onChange: (next: IimlTermRef[]) => void;
};

// M2 阶段术语 scheme 固定为 WSC3D 本地词表，
// ICONCLASS / AAT / Wikidata 字段在类型上预留，UI 暂不暴露。
const WSC3D_SCHEME = "WSC3D";

export function TermPicker({ value, categories, terms, onChange }: TermPickerProps) {
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
