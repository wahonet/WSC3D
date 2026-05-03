import { Check, Eye, EyeOff, Lock, Trash2, Unlock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { annotationPalette } from "./store";
import type { IimlAnnotation, IimlDocument } from "./types";

type AnnotationPanelProps = {
  doc?: IimlDocument;
  selectedAnnotation?: IimlAnnotation;
  draftAnnotationId?: string;
  status?: string;
  onSelectAnnotation: (id?: string) => void;
  onUpdateAnnotation: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDeleteAnnotation: (id: string) => void;
  onConfirmDraft: (id: string) => void;
};

export function AnnotationPanel({
  doc,
  selectedAnnotation,
  draftAnnotationId,
  status,
  onSelectAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onConfirmDraft
}: AnnotationPanelProps) {
  const annotations = doc?.annotations ?? [];

  return (
    <>
      <section className="panel-section annotation-status-panel">
        <div className="section-title">标注</div>
        <p className="muted-text">
          {status ?? "在视图中按住拖动以创建矩形或圆形，单击放置点；钢笔双击闭合多边形。"}
        </p>
      </section>

      <section className="panel-section annotation-list-section">
        <div className="section-title-row">
          <span className="section-title">标注列表</span>
          <span className="muted-text small">{annotations.length} 条</span>
        </div>
        {annotations.length === 0 ? (
          <p className="muted-text">暂无标注。选择一个工具开始创建。</p>
        ) : (
          <ul className="annotation-list">
            {annotations.map((annotation, index) => (
              <AnnotationRow
                annotation={annotation}
                fallbackColor={annotationPalette[index % annotationPalette.length]}
                isSelected={annotation.id === selectedAnnotation?.id}
                key={annotation.id}
                onDelete={() => onDeleteAnnotation(annotation.id)}
                onRename={(label) => onUpdateAnnotation(annotation.id, { label })}
                onSelect={() => onSelectAnnotation(annotation.id)}
                onToggleLocked={() => onUpdateAnnotation(annotation.id, { locked: !(annotation.locked === true) })}
                onToggleVisible={() => onUpdateAnnotation(annotation.id, { visible: annotation.visible === false })}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="panel-section annotation-detail-section">
        <ObjectEditor
          annotation={selectedAnnotation}
          isDraft={Boolean(selectedAnnotation && selectedAnnotation.id === draftAnnotationId)}
          onUpdate={onUpdateAnnotation}
          onDelete={onDeleteAnnotation}
          onConfirm={onConfirmDraft}
        />
      </section>
    </>
  );
}

function AnnotationRow({
  annotation,
  fallbackColor,
  isSelected,
  onDelete,
  onRename,
  onSelect,
  onToggleLocked,
  onToggleVisible
}: {
  annotation: IimlAnnotation;
  fallbackColor: string;
  isSelected: boolean;
  onDelete: () => void;
  onRename: (label: string) => void;
  onSelect: () => void;
  onToggleLocked: () => void;
  onToggleVisible: () => void;
}) {
  const [draftLabel, setDraftLabel] = useState(annotation.label ?? "");
  useEffect(() => {
    setDraftLabel(annotation.label ?? "");
  }, [annotation.id, annotation.label]);

  const visible = annotation.visible !== false;
  const locked = annotation.locked === true;
  const color = annotation.color ?? fallbackColor;

  return (
    <li className={isSelected ? "annotation-row active" : "annotation-row"}>
      <button
        className="annotation-color-dot"
        style={{ background: color }}
        title="选中此标注"
        onClick={onSelect}
        aria-pressed={isSelected}
      />
      <input
        className="annotation-name-input"
        value={draftLabel}
        placeholder="未命名标注"
        onChange={(event) => setDraftLabel(event.target.value)}
        onBlur={() => {
          if (draftLabel !== (annotation.label ?? "")) {
            onRename(draftLabel);
          }
        }}
        onClick={onSelect}
      />
      <button
        className="mini-icon"
        title={visible ? "隐藏标注" : "显示标注"}
        onClick={onToggleVisible}
      >
        {visible ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
      <button
        className="mini-icon"
        title={locked ? "解锁（允许调整）" : "锁定（防止误改）"}
        onClick={onToggleLocked}
      >
        {locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <button
        className="mini-icon danger"
        title="删除该标注"
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
    </li>
  );
}

function ObjectEditor({
  annotation,
  isDraft,
  onUpdate,
  onDelete,
  onConfirm
}: {
  annotation?: IimlAnnotation;
  isDraft: boolean;
  onUpdate: (id: string, patch: Partial<IimlAnnotation>) => void;
  onDelete: (id: string) => void;
  onConfirm: (id: string) => void;
}) {
  const [labelDraft, setLabelDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  useEffect(() => {
    setLabelDraft(annotation?.label ?? "");
    setNotesDraft(annotation?.notes ?? "");
  }, [annotation?.id]);

  if (!annotation) {
    return (
      <>
        <div className="section-title">标注详情</div>
        <p className="muted-text">在画布或上方列表中选择一个标注以编辑。</p>
      </>
    );
  }

  const commitLabel = () => {
    if (labelDraft !== (annotation.label ?? "")) {
      onUpdate(annotation.id, { label: labelDraft });
    }
  };
  const commitNotes = () => {
    if (notesDraft !== (annotation.notes ?? "")) {
      onUpdate(annotation.id, { notes: notesDraft });
    }
  };

  return (
    <>
      <div className="section-title">{isDraft ? "新建标注" : "标注详情"}</div>
      <div className="annotation-editor">
        <label>
          <span>标签</span>
          <input
            autoFocus={isDraft}
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={commitLabel}
            placeholder="例如：青龙"
          />
        </label>
        <label>
          <span>备注</span>
          <textarea
            value={notesDraft}
            onChange={(event) => setNotesDraft(event.target.value)}
            onBlur={commitNotes}
            placeholder="可填写说明、释文、出处等..."
          />
        </label>
        <div className="annotation-editor-actions">
          {isDraft ? (
            <button
              className="primary-action small"
              onClick={() => {
                commitLabel();
                commitNotes();
                onConfirm(annotation.id);
              }}
            >
              <Check size={14} /> 确定
            </button>
          ) : null}
          <button
            className="secondary-action danger"
            onClick={() => onDelete(annotation.id)}
          >
            <Trash2 size={14} /> 删除
          </button>
          {isDraft ? (
            <button
              className="secondary-action"
              onClick={() => onDelete(annotation.id)}
              title="放弃此次标注"
            >
              <X size={14} /> 取消
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
