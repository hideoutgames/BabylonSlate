import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { cn } from "@haptic/ui/lib/utils";

/**
 * A row label that explains itself in a tooltip instead of visible text under the row. Hover or
 * keyboard focus shows it; on touch a tap toggles it (long-press stays the row's context menu)
 * and does not focus or toggle the control. A dotted underline marks a label that has one.
 */
export function LabelHint({
  hint,
  children,
  className,
}: {
  hint: ReactNode;
  /** The label element (`FieldLabel`, `Label`); it becomes the trigger. */
  children: ReactElement;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const touch = useRef(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next, details) => {
        // A tap toggles it below; Base UI would close it again on the same press.
        if (touch.current && details.reason === "trigger-press") return;
        setOpen(next);
      }}
    >
      <TooltipTrigger
        render={children}
        data-label-hint=""
        className={cn(
          "cursor-help underline decoration-muted-foreground/60 decoration-dotted underline-offset-[3px]",
          className,
        )}
        onPointerDown={(event) => {
          touch.current = event.pointerType !== "mouse";
        }}
        onClick={(event) => {
          if (!touch.current) return;
          event.preventDefault();
          setOpen((current) => !current);
        }}
      />
      <TooltipContent className="max-w-64 whitespace-normal">{hint}</TooltipContent>
    </Tooltip>
  );
}
