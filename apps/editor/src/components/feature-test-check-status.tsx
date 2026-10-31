import type { ReactNode } from "react";
import { SelectableText } from "@haptic/editor-kit";

/** The compact status bar a running Feature Test Check shows instead of its dialog, with one action. */
export function FeatureTestCheckStatus({ message, action }: { message: string; action: ReactNode }) {
  return (
    <div className="fixed left-3 top-[max(0.5rem,env(safe-area-inset-top))] z-[70] flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md"
      role="status" aria-label="Feature Test Check" data-testid="feature-test-check-status">
      <SelectableText className="px-1 text-xs">Feature Test Check · {message}</SelectableText>
      {action}
    </div>
  );
}
