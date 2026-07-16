import type { ButtonHTMLAttributes, ReactNode } from "react";

type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  active?: boolean;
};

export function Chip({ children, active, className = "", ...rest }: ChipProps) {
  return (
    <button
      type="button"
      className={`ui-chip${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
