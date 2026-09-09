import type { ReactNode } from "react";
import { cn } from "@babylonslate/ui/lib/utils";

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
      className={cn("flex min-h-[var(--chrome-row,28px)] flex-wrap items-center gap-1 border-b border-border bg-panel-header px-2", className)}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
