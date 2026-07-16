import { LayoutGrid, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../Button";
import { usePanelLayoutContext } from "./PanelLayoutContext";
import type { PanelDefinition } from "./types";

type PanelMenuProps = {
  definitions: PanelDefinition[];
};

export function PanelMenu({ definitions }: PanelMenuProps) {
  const { layout, toggleOpen, resetLayout } = usePanelLayoutContext();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="shell-panel-menu" ref={ref}>
      <Button variant="ghost" compact onClick={() => setOpen((v) => !v)}>
        <LayoutGrid size={14} />
        面板
      </Button>
      {open ? (
        <div className="shell-panel-menu__dropdown">
          <div className="shell-panel-menu__list">
            {definitions.map((def) => {
              const entry = layout[def.id];
              const checked = entry?.open ?? false;
              return (
                <label key={def.id} className="shell-panel-menu__item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOpen(def.id, !checked)}
                  />
                  <span>{def.title}</span>
                </label>
              );
            })}
          </div>
          <Button variant="ghost" compact onClick={() => { resetLayout(); setOpen(false); }}>
            <RotateCcw size={12} />
            重置布局
          </Button>
        </div>
      ) : null}
    </div>
  );
}
