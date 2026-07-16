import type { ReactNode } from "react";

export type TabItem<T extends string> = {
  id: T;
  label: string;
  badge?: number | string;
  disabled?: boolean;
};

type TabsProps<T extends string> = {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
};

export function Tabs<T extends string>({ items, value, onChange, className = "" }: TabsProps<T>) {
  return (
    <div className={`ui-tabs${className ? ` ${className}` : ""}`} role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          disabled={item.disabled}
          className={`ui-tabs__tab${value === item.id ? " is-active" : ""}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.badge !== undefined ? <span className="ui-tabs__badge">{item.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

type TabPanelProps = {
  children: ReactNode;
  className?: string;
};

export function TabPanel({ children, className = "" }: TabPanelProps) {
  return (
    <div className={`ui-tab-panel${className ? ` ${className}` : ""}`} role="tabpanel">
      {children}
    </div>
  );
}
