import type { ReactNode } from "react";
import { FloatingPanel } from "./FloatingPanel";
import { usePanelLayoutContext } from "./PanelLayoutContext";
import type { PanelDefinition } from "./types";

export type PanelRenderProps = {
  id: string;
};

type PanelHostProps = {
  definitions: PanelDefinition[];
  renderPanel: (id: string) => ReactNode;
};

export function PanelHost({ definitions, renderPanel }: PanelHostProps) {
  const { layout, bringToFront, updatePanel, toggleOpen } = usePanelLayoutContext();

  return (
    <div className="fp-host" aria-label="悬浮面板">
      {definitions.map((def) => {
        const entry = layout[def.id];
        if (!entry) return null;
        return (
          <FloatingPanel
            key={def.id}
            id={def.id}
            title={def.title}
            layout={entry}
            onLayoutChange={(patch) => updatePanel(def.id, patch)}
            onClose={() => toggleOpen(def.id, false)}
            onFocus={() => bringToFront(def.id)}
          >
            {renderPanel(def.id)}
          </FloatingPanel>
        );
      })}
    </div>
  );
}

export { PanelLayoutProvider } from "./PanelLayoutContext";
