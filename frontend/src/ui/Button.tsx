import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "ghost" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
  compact?: boolean;
};

export function Button({ variant = "ghost", compact, className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`ui-btn ui-btn--${variant}${compact ? " ui-btn--compact" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
