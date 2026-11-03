import { cloneElement, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref } from "react";
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
  return merged;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * Where the tooltip points: the label's text, not its box. A settings or grid label can fill a
 * whole column, and the tooltip would otherwise float over its middle.
 */
function textBounds(element: Element | null): DOMRect {
  if (!element) return new DOMRect();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const text = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  return text && text.width > 0 ? text : element.getBoundingClientRect();
}

/**
 * A label that explains itself in a tooltip instead of visible text: a row label, a graph node
 * title or a pin name. Hover or keyboard focus shows it; on touch a tap toggles it (long-press
 * stays the context menu) and does not focus or toggle the control. A dotted underline marks a
 * label that has one. The tooltip points at the label's text.
 */
export function LabelHint({
  hint,
  children,
  className,
  underline = true,
  delay,
}: {
  hint: ReactNode;
  /** The label element (`FieldLabel`, `Label`, a title `span`); it becomes the trigger. */
  children: ReactElement;
  className?: string;
  /** Off for a label whose tooltip is expected, such as a graph node title. */
  underline?: boolean;
  /** Hover delay in ms; a graph canvas waits so moving across nodes does not flash tooltips. */
  delay?: number;
}) {
  const [open, setOpen] = useState(false);
  const touch = useRef(false);
  const element = useRef<Element | null>(null);
  const anchor = useMemo(() => ({
    getBoundingClientRect: () => textBounds(element.current),
    get contextElement() {
      return element.current ?? undefined;
    },
  }), []);
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
        render={(props) => {
          const merged = labelProps(props as Props, children.props as Props);
          // Base UI positions and dismisses through the trigger's ref; the anchor reads the same element.
          const triggerRef = (props as Props).ref as Ref<Element> | undefined;
          merged.ref = (node: Element | null) => {
            element.current = node;
            assignRef(triggerRef, node);
          };
          return cloneElement(children, merged);
        }}
        data-label-hint=""
        {...(delay !== undefined ? { delay } : {})}
        className={cn(
          "cursor-help",
          underline && "underline decoration-muted-foreground/60 decoration-dotted underline-offset-[3px]",
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
      <TooltipContent anchor={anchor} className="max-w-64 whitespace-normal">{hint}</TooltipContent>
    </Tooltip>
  );
}
