import { useRef, useSyncExternalStore } from "react";
import { LockIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { useDocumentActions, useSourceControl } from "../context/document-context";
import { useRetainedValue } from "../lib/use-retained-value";

const NO_PATHS: readonly string[] = [];

// Pointers pressed anywhere in the window, tracked while a prompt is mounted.
const pressedPointers = new Set<number>();
const pointerListeners = new Set<() => void>();

function notePointers(change: () => void): void {
  const before = pressedPointers.size > 0;
  change();
  if (before !== pressedPointers.size > 0) for (const listener of pointerListeners) listener();
}

const onPointerDown = (event: PointerEvent) => notePointers(() => pressedPointers.add(event.pointerId));
const onPointerUp = (event: PointerEvent) => notePointers(() => pressedPointers.delete(event.pointerId));
const onBlur = () => notePointers(() => pressedPointers.clear());

function subscribePointers(listener: () => void): () => void {
  if (pointerListeners.size === 0) {
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("blur", onBlur);
  }
  pointerListeners.add(listener);
  return () => {
    pointerListeners.delete(listener);
    if (pointerListeners.size > 0) return;
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    window.removeEventListener("blur", onBlur);
    pressedPointers.clear();
  };
}

const anyPointerPressed = () => pressedPointers.size > 0;

/**
 * **Lock {Name}?**: Lock On Edit is Ask and a file was edited for the first
 * time. One prompt lists every file waiting (an operation that edits several
 * asks once), and its answer applies to the files it lists; Escape and
 * Don't Lock leave them unlocked. It opens only once
 * no pointer is pressed, so a drag finishes first, and it focuses itself,
 * not an action, so a key typed while it appears answers nothing.
 */
export function SourceControlLockPrompt() {
  const { sourceControl } = useSourceControl();
  const { getOpenDocuments } = useDocumentActions();
  const waiting = sourceControl.lockPrompt;
  const pressed = useSyncExternalStore(subscribePointers, anyPointerPressed, () => false);
  const open = waiting.length > 0 && !pressed;
  // Kept while the dialog fades out; the answer is for the files it lists.
  const paths = useRetainedValue(open ? waiting : null, NO_PATHS);
  const popupRef = useRef<HTMLDivElement>(null);
  const names = paths.map((path) => {
    const doc = getOpenDocuments().find((entry) => entry.ref.path === path && !entry.background);
    return doc?.ref.label ?? path.split("/").pop() ?? path;
  });
  const answer = (lock: boolean) => {
    void sourceControl.answerLockPrompt(paths, lock);
  };
  const single = names.length === 1;
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && open) answer(false); }}>
      <AlertDialogContent ref={popupRef} initialFocus={popupRef} data-testid="source-control-lock-prompt">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <LockIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>{single ? `Lock ${names[0]}?` : `Lock ${names.length} Files?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {single
              ? "No one else can save it while you hold the lock."
              : "No one else can save them while you hold the locks."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {single ? null : (
          <ul className="max-h-48 divide-y overflow-y-auto overscroll-y-contain rounded-md border bg-muted/30 text-sm" data-testid="source-control-lock-prompt-files">
            {names.map((name, index) => (
              <li key={paths[index]} className="min-w-0 truncate px-3 py-1.5" title={paths[index]}>
                {name}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="source-control-lock-prompt-dont-lock">
            Don&apos;t Lock
          </AlertDialogCancel>
          <AlertDialogAction data-testid="source-control-lock-prompt-lock" onClick={() => answer(true)}>
            Lock
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
