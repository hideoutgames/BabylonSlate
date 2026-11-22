import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Textarea } from "@haptic/ui/components/textarea";
import { cn } from "@haptic/ui/lib/utils";

/**
 * A Math Expression node's formula typed in place: a multiline field that takes focus with its
 * text selected. A click away or Ctrl/Cmd+Enter commits, Escape cancels; Enter alone adds a line.
 * `nodrag nopan nowheel` keep presses, drags and scrolls in the field off the canvas.
 */
export function MathExpressionFormulaField({ value, onDone }: {
  value: string;
  /** The new text, or null when cancelled. */
  onDone: (formula: string | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.select();
  }, []);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(commit ? (ref.current?.value ?? value) : null);
  };
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <Textarea
      ref={ref}
      defaultValue={value}
      aria-label="Formula"
      data-testid="math-expression-formula-input"
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      rows={Math.max(1, value.split("\n").length)}
      className={cn(
        "nodrag nopan nowheel min-h-8 resize-none rounded-sm px-2 py-1 font-mono text-sm leading-snug md:text-sm",
        "pointer-coarse:min-h-11",
      )}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onBlur={() => finish(true)}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          finish(true);
        }
      }}
    />
  );
}
