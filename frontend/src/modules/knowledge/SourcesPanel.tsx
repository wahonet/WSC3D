/**
 * 文献与文段面板（知识库工作区右栏的"录入"侧）
 *
 * - 文献 CRUD：题名 / 年份 / 作者 / 类型
 * - 每部文献下列出其文段（页码 + 摘要），可新增 / 编辑 / 删除
 * - 文段编辑器：录入原文时点「识别提及」跑字面匹配预标（auto 徽标），
 *   也可用概念选择器手工添加提及；保存即入库
 */

import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createKbSegment,
  createKbSource,
  deleteKbSegment,
  deleteKbSource,
  suggestMentions,
  updateKbSegment,
  updateKbSource,
  type KbMention,
  type KbSegment,
  type KbSnapshot
} from "../../api/kb";
import { Button } from "../../ui/Button";
import { Field, Input, Select } from "../../ui/Field";
import { DraftInput } from "../annotation/DraftFields";
import { ConceptPicker } from "./ConceptPicker";

export type SourcesPanelProps = {
  snapshot: KbSnapshot;
  editingSegmentId?: string;
  onChanged: () => void;
  onStatus: (message: string) => void;
  onCloseSegmentEditor: () => void;
};

export function SourcesPanel({ snapshot, editingSegmentId, onChanged, onStatus, onCloseSegmentEditor }: SourcesPanelProps) {
  const [newTitle, setNewTitle] = useState("");
  const [newYear, setNewYear] = useState("");
  const [editorState, setEditorState] = useState<{ sourceId: string; segment?: KbSegment } | undefined>(() => {
    if (!editingSegmentId) return undefined;
    const segment = snapshot.segments.find((s) => s.id === editingSegmentId);
    return segment ? { sourceId: segment.sourceId, segment } : undefined;
  });

  useEffect(() => {
    if (!editingSegmentId) return;
    const segment = snapshot.segments.find((s) => s.id === editingSegmentId);
    if (segment) setEditorState({ sourceId: segment.sourceId, segment });
  }, [editingSegmentId, snapshot.segments]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      onChanged();
      return true;
    } catch (error) {
      onStatus(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const segmentsBySource = useMemo(() => {
    const map = new Map<string, KbSegment[]>();
    for (const segment of snapshot.segments) {
      const list = map.get(segment.sourceId) ?? [];
      list.push(segment);
      map.set(segment.sourceId, list);
    }
    return map;
  }, [snapshot.segments]);

  if (editorState) {
    return (
      <SegmentEditor
        snapshot={snapshot}
        sourceId={editorState.sourceId}
        segment={editorState.segment}
        onStatus={onStatus}
        onDone={(changed) => {
          setEditorState(undefined);
          onCloseSegmentEditor();
          if (changed) onChanged();
        }}
      />
    );
  }

  return (
    <div className="kb-detail">
      <header className="kb-detail__header">
        <strong className="kb-detail__title">
          <BookOpen size={14} /> 文献与文段
        </strong>
        <span className="kb-detail__crumb">
          {snapshot.sources.length} 部文献 · {snapshot.segments.length} 条文段
        </span>
      </header>

      <section className="kb-detail__section">
        <div className="kb-inline-form">
          <Input value={newTitle} placeholder="文献题名，如：中国汉画像石全集第1卷" onChange={(e) => setNewTitle(e.target.value)} />
          <Input value={newYear} placeholder="年份" style={{ maxWidth: 88 }} onChange={(e) => setNewYear(e.target.value)} />
          <Button
            compact
            variant="primary"
            disabled={!newTitle.trim()}
            onClick={() =>
              void run("新增文献", () => createKbSource({ title: newTitle, year: newYear || undefined })).then((ok) => {
                if (ok) {
                  setNewTitle("");
                  setNewYear("");
                }
              })
            }
          >
            <Plus size={13} /> 文献
          </Button>
        </div>
      </section>

      {snapshot.sources.length === 0 ? <p className="ui-muted">先登记文献，再录入文段。</p> : null}

      {snapshot.sources.map((source) => {
        const segments = segmentsBySource.get(source.id) ?? [];
        return (
          <section key={source.id} className="kb-detail__section kb-source">
            <header className="kb-source__head">
              <div className="kb-source__title-block">
                <DraftInput
                  value={source.title}
                  placeholder="题名"
                  onCommit={(v) => void run("修改文献", () => updateKbSource(source.id, { title: v }))}
                />
                <div className="kb-source__meta-row">
                  <DraftInput
                    value={source.year ?? ""}
                    placeholder="年份"
                    onCommit={(v) => void run("修改文献", () => updateKbSource(source.id, { year: v || undefined }))}
                  />
                  <DraftInput
                    value={source.author ?? ""}
                    placeholder="作者/编者"
                    onCommit={(v) => void run("修改文献", () => updateKbSource(source.id, { author: v || undefined }))}
                  />
                </div>
              </div>
              <div className="kb-source__actions">
                <Button compact onClick={() => setEditorState({ sourceId: source.id })}>
                  <Plus size={13} /> 文段
                </Button>
                <Button
                  compact
                  variant="danger"
                  title={segments.length > 0 ? "先删除其下文段" : "删除文献"}
                  disabled={segments.length > 0}
                  onClick={() => void run("删除文献", () => deleteKbSource(source.id))}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </header>
            {segments.length > 0 ? (
              <ul className="kb-segment-list">
                {segments.map((segment) => (
                  <li key={segment.id} className="kb-source__segment">
                    <button type="button" className="kb-segment-item" onClick={() => setEditorState({ sourceId: source.id, segment })}>
                      <span className="kb-segment-item__source">
                        {segment.page ? `页 ${segment.page}` : "（无页码）"} · 提及 {segment.mentions.length}
                      </span>
                      <span className="kb-segment-item__text">{segment.text}</span>
                    </button>
                    <button
                      type="button"
                      className="kb-chip__remove"
                      title="删除文段"
                      onClick={() => {
                        if (window.confirm("删除该文段？")) void run("删除文段", () => deleteKbSegment(segment.id));
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ui-muted">暂无文段。</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------------- 文段编辑器 ----------------

function SegmentEditor({
  snapshot,
  sourceId,
  segment,
  onDone,
  onStatus
}: {
  snapshot: KbSnapshot;
  sourceId: string;
  segment?: KbSegment;
  onDone: (changed: boolean) => void;
  onStatus: (message: string) => void;
}) {
  const [currentSourceId, setCurrentSourceId] = useState(sourceId);
  const [page, setPage] = useState(segment?.page ?? "");
  const [locator, setLocator] = useState(segment?.locator ?? "");
  const [text, setText] = useState(segment?.text ?? "");
  const [mentions, setMentions] = useState<KbMention[]>(segment?.mentions ?? []);
  const [detecting, setDetecting] = useState(false);

  const conceptLabel = useMemo(() => {
    const map = new Map(snapshot.concepts.map((c) => [c.id, c.label]));
    return (id: string) => map.get(id) ?? id;
  }, [snapshot.concepts]);

  const detect = async () => {
    if (!text.trim()) return;
    setDetecting(true);
    try {
      const suggestions = await suggestMentions(text);
      setMentions((prev) => {
        const existing = new Set(prev.map((m) => m.conceptId));
        const added = suggestions
          .filter((s) => !existing.has(s.conceptId))
          .map((s) => ({ conceptId: s.conceptId, matchedForm: s.matchedForm, auto: true }));
        return [...prev, ...added];
      });
      onStatus(`识别提及：命中 ${suggestions.length} 个概念（字面匹配，可手动增删）`);
    } catch (error) {
      onStatus(`识别提及失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDetecting(false);
    }
  };

  const save = async () => {
    try {
      if (segment) {
        await updateKbSegment(segment.id, { sourceId: currentSourceId, page, locator, text, mentions });
      } else {
        await createKbSegment({ sourceId: currentSourceId, page, locator, text, mentions });
      }
      onDone(true);
    } catch (error) {
      onStatus(`保存文段失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="kb-detail">
      <header className="kb-detail__header">
        <strong className="kb-detail__title">{segment ? "编辑文段" : "录入文段"}</strong>
      </header>
      <Field label="所属文献">
        <Select value={currentSourceId} onChange={(e) => setCurrentSourceId(e.target.value)}>
          {snapshot.sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.title}
              {source.year ? `（${source.year}）` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <div className="kb-inline-form">
        <Field label="页码 / 图版">
          <Input value={page} placeholder="如：99" onChange={(e) => setPage(e.target.value)} />
        </Field>
        <Field label="位置说明">
          <Input value={locator} placeholder="如：第 3 层右起第 2 幅" onChange={(e) => setLocator(e.target.value)} />
        </Field>
      </div>
      <Field label="文段原文">
        <textarea
          className="ui-input iiml-textarea"
          rows={6}
          value={text}
          placeholder="录入文献原文（描述、著录、释读…）"
          onChange={(e) => setText(e.target.value)}
        />
      </Field>

      <section className="kb-detail__section">
        <header className="kb-detail__subheader">
          提及概念（{mentions.length}）
          <Button compact disabled={!text.trim() || detecting} onClick={() => void detect()}>
            {detecting ? "识别中…" : "识别提及"}
          </Button>
        </header>
        <div className="kb-chip-row">
          {mentions.map((mention) => (
            <span key={mention.conceptId} className={`kb-chip${mention.auto ? " is-auto" : ""}`} title={mention.matchedForm ? `命中词形：${mention.matchedForm}` : undefined}>
              {conceptLabel(mention.conceptId)}
              {mention.auto ? <small>auto</small> : null}
              <button
                type="button"
                className="kb-chip__remove"
                title="移除提及"
                onClick={() => setMentions((prev) => prev.filter((m) => m.conceptId !== mention.conceptId))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <ConceptPicker
          concepts={snapshot.concepts}
          categories={snapshot.categories}
          placeholder="手动添加提及概念…"
          excludeIds={mentions.map((m) => m.conceptId)}
          onPick={(concept) => setMentions((prev) => [...prev, { conceptId: concept.id }])}
        />
      </section>

      <div className="kb-inline-form">
        <Button variant="primary" disabled={!text.trim() || !currentSourceId} onClick={() => void save()}>
          保存文段
        </Button>
        <Button variant="ghost" onClick={() => onDone(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}
