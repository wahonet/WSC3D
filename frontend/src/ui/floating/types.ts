export type PanelId = string;

export type PanelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PanelLayoutEntry = PanelRect & {
  open: boolean;
  collapsed: boolean;
  zIndex: number;
};

export type PanelLayoutState = Record<PanelId, PanelLayoutEntry>;

export type PanelDefinition = {
  id: PanelId;
  title: string;
  defaultRect: PanelRect;
  minWidth?: number;
  minHeight?: number;
  defaultOpen?: boolean;
};

export const DEFAULT_PANEL_MIN = { width: 240, height: 160 } as const;
