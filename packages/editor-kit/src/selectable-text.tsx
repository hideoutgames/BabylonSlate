import type { ReactNode } from "react";

export interface SelectableTextProps {
  children: ReactNode;
  className?: string;
}

/**
 * Opt-in selectable text inside a shell that defaults to user-select: none.
 */
export function SelectableText({ children, className }: SelectableTextProps) {
  return (
    <span className={["selectable-text", className].filter(Boolean).join(" ")}>
      {children}
    </span>
  );
}
