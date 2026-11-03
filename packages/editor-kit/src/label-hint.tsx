import { cloneElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@haptic/ui/components/tooltip";
import { cn } from "@haptic/ui/lib/utils";

type Props = Record<string, unknown>;

/**
 * The trigger props merged onto the label as Base UI merges a `render` element (the label's own
 * props win, handlers run label first, class names join), without the trigger's `data-slot`: the
 * label keeps its own (`field-label`), which settings and grid row styles select.
 */
function labelProps(trigger: Props, own: Props): Props {
  const { "data-slot": _slot, ...rest } = trigger;
  void _slot;
  const merged: Props = { ...rest, ...own };
  for (const [key, handler] of Object.entries(rest)) {
    const ownHandler = own[key];
    if (!/^on[A-Z]/.test(key) || typeof handler !== "function" || typeof ownHandler !== "function") continue;
    merged[key] = (...args: unknown[]) => {
      ownHandler(...args);
      handler(...args);
    };
  }
  merged.className = cn(rest.className as string | undefined, own.className as string | undefined);
  if (rest.style || own.style) merged.style = { ...(rest.style as object), ...(own.style as object) };
  // The tooltip positions against the trigger, so its ref wins.
  merged.ref = rest.ref;
  return merged;
}

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
        render={(props) => cloneElement(children, labelProps(props as Props, children.props as Props))}
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
