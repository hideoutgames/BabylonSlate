import type { ReactNode } from "react";

export function ToolbarStrip({
  children,
  className,
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      className={`flex min-h-[var(--touch-target,44px)] flex-wrap items-center gap-1 border-b border-border bg-card px-2 ${className ?? ""}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
