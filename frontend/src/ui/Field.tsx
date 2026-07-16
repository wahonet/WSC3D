import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes } from "react";

type FieldProps = {
  label: string;
  children: ReactNode;
  className?: string;
};

export function Field({ label, children, className = "" }: FieldProps) {
  return (
    <label className={`ui-field${className ? ` ${className}` : ""}`}>
      <span className="ui-field__label">{label}</span>
      {children}
    </label>
  );
}

export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`ui-select${className ? ` ${className}` : ""}`} {...rest} />;
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`ui-input${className ? ` ${className}` : ""}`} {...rest} />;
}
