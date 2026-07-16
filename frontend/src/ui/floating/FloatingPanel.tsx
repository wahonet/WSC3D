import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useRef, type ReactNode } from "react";
import { IconButton } from "../IconButton";
import type { PanelLayoutEntry } from "./types";

type FloatingPanelProps = {
  id: string;
  title: string;
  layout: PanelLayoutEntry;
  onLayoutChange: (patch: Partial<PanelLayoutEntry>) => void;
  onClose: () => void;
  onFocus: () => void;
  children: ReactNode;
};

export function FloatingPanel({
  title,
  layout,
  onLayoutChange,
  onClose,
  onFocus,
  children
}: FloatingPanelProps) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  const onHeaderPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { startX: event.clientX, startY: event.clientY, origX: layout.x, origY: layout.y };
      onFocus();
    },
    [layout.x, layout.y, onFocus]
  );

  const onHeaderPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!dragRef.current) return;
      const dx = event.clientX - dragRef.current.startX;
      const dy = event.clientY - dragRef.current.startY;
      onLayoutChange({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    },
    [onLayoutChange]
  );

  const onHeaderPointerUp = useCallback((event: React.PointerEvent) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        origW: layout.width,
        origH: layout.height
      };
      onFocus();
    },
    [layout.width, layout.height, onFocus]
  );

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!resizeRef.current) return;
      const dw = event.clientX - resizeRef.current.startX;
      const dh = event.clientY - resizeRef.current.startY;
      onLayoutChange({
        width: resizeRef.current.origW + dw,
        height: resizeRef.current.origH + dh
      });
    },
    [onLayoutChange]
  );

  const onResizePointerUp = useCallback((event: React.PointerEvent) => {
    resizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  if (!layout.open) return null;

  return (
    <div
      className={`fp-panel${layout.collapsed ? " is-collapsed" : ""}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.collapsed ? undefined : layout.height,
        zIndex: layout.zIndex
      }}
      onPointerDown={onFocus}
    >
      <header
        className="fp-panel__header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <span className="fp-panel__title">{title}</span>
        <div className="fp-panel__actions">
          <IconButton
            size="sm"
            label={layout.collapsed ? "展开" : "折叠"}
            icon={layout.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            onClick={() => onLayoutChange({ collapsed: !layout.collapsed })}
          />
          <IconButton size="sm" label="关闭" icon={<X size={14} />} onClick={onClose} />
        </div>
      </header>
      {!layout.collapsed ? (
        <div className="fp-panel__body">{children}</div>
      ) : null}
      {!layout.collapsed ? (
        <div
          className="fp-panel__resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
        />
      ) : null}
    </div>
  );
}
