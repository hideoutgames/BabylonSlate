import { useEffect, useRef, type MouseEvent } from "react";
import { doubleTapWindowMs, InlineRenameInput } from "@haptic/editor-kit";
import { useGraphEditorContext } from "./graph-editor-context";

/** How long a new rename field keeps claiming focus from a closing dialog (Add Node) that hands it back. */
const RENAME_FOCUS_CLAIM_MS = 1500;

/**
 * A node title's inline rename field. A host may open it while a modal dialog still holds focus
 * (a node just added from Add Node, whose dialog then returns focus to its opener), so until the
 * person presses elsewhere it takes focus, with its text selected, once no other dialog is open.
 */
export function NodeRenameField({
  title,
  onDone,
  className,
}: {
  title: string;
  onDone: (name: string | null) => void;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector("input");
    if (!input) return undefined;
    let pressedElsewhere = false;
    let frame = 0;
    const blocked = () =>
      Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some((dialog) => !dialog.contains(input));
    const claim = () => {
      frame = 0;
      if (pressedElsewhere || !input.isConnected || document.activeElement === input) return;
      if (blocked()) {
        frame = requestAnimationFrame(claim);
        return;
      }
      input.focus({ preventScroll: true });
      input.select();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target !== input) pressedElsewhere = true;
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target !== input && !frame) frame = requestAnimationFrame(claim);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    claim();
    const stop = setTimeout(() => {
      pressedElsewhere = true;
      document.removeEventListener("focusin", onFocusIn, true);
    }, RENAME_FOCUS_CLAIM_MS);
    return () => {
      clearTimeout(stop);
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);
  return (
    // `nodrag` and `nopan` keep presses in the field from moving the node or the canvas.
    <span ref={ref} className="nodrag nopan nowheel flex min-w-40 flex-1 text-foreground">
      <InlineRenameInput
        value={title}
        aria-label="Name"
        data-testid="graph-node-rename"
        className={className ?? "h-7 min-h-7 text-base md:text-base"}
        onDone={onDone}
      />
    </span>
  );
}


/**
 * A node title's rename gestures: a double-click, or two taps within the double-tap time, calls
 * `GraphEditor.onNodeTitleDoubleClick`. A double-click the canvas takes for a rename stops there, so
 * the host's `onNodeDoubleClick` (opening a function) keeps to the node body. Undefined when the host
 * has no title rename; presses on pins never count.
 */
export function useNodeTitleGestures(nodeId: string):
  | { onClick: (event: MouseEvent) => void; onDoubleClick: (event: MouseEvent) => void }
  | undefined {
  const { titleDoubleClick } = useGraphEditorContext();
  const lastTap = useRef(0);
  if (!titleDoubleClick) return undefined;
  const onPin = (event: MouseEvent) =>
    event.target instanceof Element && event.target.closest(".react-flow__handle, input") !== null;
  return {
    onClick: (event) => {
      if (onPin(event)) return;
      const now = Date.now();
      if (now - lastTap.current < doubleTapWindowMs()) {
        lastTap.current = 0;
        if (titleDoubleClick(nodeId, "tap")) event.stopPropagation();
        return;
      }
      lastTap.current = now;
    },
    onDoubleClick: (event) => {
      if (onPin(event)) return;
      if (titleDoubleClick(nodeId, "dblclick")) event.stopPropagation();
    },
  };
}

/** The rename field's starting text: the host's `renamingNodeValue`, else the shown title. */
export function useRenameValue(title: string): string {
  const { renamingNodeValue } = useGraphEditorContext();
  return renamingNodeValue ?? title;
}
