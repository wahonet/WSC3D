/**
 * 失焦提交的受控输入（IimlPanel / RegionEditor 共用）
 *
 * IIML 面板的所有文本字段都走"本地 draft + onBlur 提交"模式：
 * 输入过程不触发 reducer / autosave，失焦且值有变化时才 commit，
 * 避免每敲一个字都压一条 undo 记录 + 触发 900ms 防抖保存。
 */

import { useEffect, useState } from "react";
import { Input } from "../../ui/Field";

export function DraftInput({
  value,
  placeholder,
  datalistId,
  onCommit
}: {
  value: string;
  placeholder?: string;
  // 可选 <datalist> 建议（如 motif 按类别速查表）
  datalistId?: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      placeholder={placeholder}
      list={datalistId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

export function DraftTextarea({
  value,
  placeholder,
  rows = 3,
  onCommit
}: {
  value: string;
  placeholder?: string;
  rows?: number;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <textarea
      className="ui-input iiml-textarea"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}
