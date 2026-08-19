import type { ReactNode } from "react";
import { cn } from "@babylonslate/ui/lib/utils";

export interface PanelFrameProps {
  title?: string;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function PanelFrame({
  title,
  toolbar,
  children,
  className,
  "data-testid": testId,
}: PanelFrameProps) {
  const showHeader = Boolean(title || toolbar);
  return (
    <section
      className={cn("flex h-full min-h-0 flex-col bg-sidebar", className)}
      data-testid={testId}
    >
      {showHeader ? (
        <header
          className={cn(
            "flex min-h-[var(--chrome-row,28px)] shrink-0 items-center gap-1 border-b border-border bg-card px-2",
            title ? "justify-between" : "justify-end",
          )}
        >
          {title ? (
            <h2 className="truncate text-sm font-medium">{title}</h2>
          ) : null}
          {toolbar ? (
            <div className="flex shrink-0 items-center gap-1">{toolbar}</div>
          ) : null}
        </header>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-pan-y">
        {children}
      </div>
    </section>
  );
}
