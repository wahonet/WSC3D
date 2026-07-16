import type { ButtonHTMLAttributes, ReactNode } from "react";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  label: string;
  active?: boolean;
  size?: "sm" | "md";
};

export function IconButton({ icon, label, active, size = "md", className = "", ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`ui-icon-btn ui-icon-btn--${size}${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
      {...rest}
    >
      {icon}
    </button>
  );
}
