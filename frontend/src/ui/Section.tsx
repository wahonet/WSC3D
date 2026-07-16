import type { ReactNode } from "react";

type SectionProps = {
  title?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
};

export function Section({ title, children, className = "", actions }: SectionProps) {
  return (
    <section className={`ui-section${className ? ` ${className}` : ""}`}>
      {title ? (
        <header className="ui-section__header">
          <h3 className="ui-section__title">{title}</h3>
          {actions ? <div className="ui-section__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="ui-section__body">{children}</div>
    </section>
  );
}
