import type { ReactNode } from "react";

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
      className={`flex h-full min-h-0 flex-col bg-background ${className ?? ""}`}
      data-testid={testId}
    >
      {showHeader ? (
        <header
          className={`flex min-h-[var(--touch-target,44px)] shrink-0 items-center gap-2 border-b border-border px-3 ${
            title ? "justify-between" : "justify-end"
          }`}
        >
          {title ? (
            <h2 className="truncate text-sm font-medium">{title}</h2>
          ) : null}
          {toolbar ? (
            <div className="flex shrink-0 items-center gap-1">{toolbar}</div>
          ) : null}
        </header>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}
