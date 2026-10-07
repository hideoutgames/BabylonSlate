import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Input } from "@babylonslate/ui/components/input";
import { cn } from "@babylonslate/ui/lib/utils";

export type InlineRenameEnd = "enter" | "escape" | "blur";

/** Closing menus and dialogs restore focus to their trigger just after the input mounts; such a blur without a user gesture is undone. */
const FOCUS_SETTLE_MS = 400;

/** Taps closer together than this count as a double-tap rename gesture. */
export const INLINE_RENAME_DOUBLE_TAP_MS = 350;

export interface InlineRenameInputProps {
  value: string;
  /** `name` is the trimmed text, or null when cancelled, empty, or unchanged. */
  onDone: (name: string | null, reason: InlineRenameEnd) => void;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

/** Text input that opens focused with its text selected; Enter or click-away commits, Escape cancels. */
export function InlineRenameInput({ value, onDone, className, "aria-label": label, "data-testid": testId }: InlineRenameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const mountedAt = useRef(0);
  const userMoved = useRef(false);
  const focusAndSelect = () => {
    const input = ref.current;
    if (!input || finished.current) return;
    input.focus({ preventScroll: true });
    input.select();
  };
  useLayoutEffect(() => {
    mountedAt.current = performance.now();
    focusAndSelect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only focus
  }, []);
  useEffect(() => {
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target !== ref.current) userMoved.current = true;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  const finish = (commit: boolean, reason: InlineRenameEnd) => {
    if (finished.current) return;
    finished.current = true;
    const next = ref.current?.value.trim() ?? "";
    onDone(commit && next && next !== value ? next : null, reason);
  };
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return <Input
    ref={ref}
    defaultValue={value}
    aria-label={label}
    data-testid={testId}
    spellCheck={false}
    autoComplete="off"
    className={cn("h-6 min-h-6 min-w-0 flex-1 rounded-sm px-1 py-0 text-[13px] md:text-[13px] pointer-coarse:h-9", className)}
    onPointerDown={stop}
    onClick={stop}
    onDoubleClick={stop}
    onBlur={() => {
      if (!userMoved.current && performance.now() - mountedAt.current < FOCUS_SETTLE_MS) {
        setTimeout(focusAndSelect, 0);
        return;
      }
      finish(true, "blur");
    }}
    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Tab") userMoved.current = true;
      if (event.key === "Enter") { event.preventDefault(); finish(true, "enter"); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false, "escape"); }
    }}
  />;
}

/** Calls `onDoubleTap` for a second touch/pen tap within the double-tap window; mouse uses native dblclick. */
export function useDoubleTap(onDoubleTap: () => void) {
  const last = useRef(0);
  return (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    const now = Date.now();
    if (now - last.current <= INLINE_RENAME_DOUBLE_TAP_MS) {
      last.current = 0;
      onDoubleTap();
    } else last.current = now;
  };
}

export interface EditableNameProps {
  value: string;
  onRename: (name: string) => void;
  /** Controlled editing state; omit to let double-click / double-tap / F2 own it. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

/** Plain text name that becomes an `InlineRenameInput` on double-click, double-tap, or F2. */
export function EditableName({ value, onRename, editing: controlled, onEditingChange, disabled = false, placeholder = "Unnamed", className, "aria-label": label, "data-testid": testId }: EditableNameProps) {
  const [local, setLocal] = useState(false);
  const editing = !disabled && (controlled ?? local);
  const setEditing = (next: boolean) => {
    if (controlled === undefined) setLocal(next);
    onEditingChange?.(next);
  };
  const textRef = useRef<HTMLSpanElement>(null);
  const onTap = useDoubleTap(() => { if (!disabled) setEditing(true); });
  if (editing) {
    return <InlineRenameInput value={value} aria-label={label} data-testid={testId} className={className} onDone={(name, reason) => {
      if (name !== null) onRename(name);
      setEditing(false);
      if (reason !== "blur") requestAnimationFrame(() => textRef.current?.focus({ preventScroll: true }));
    }} />;
  }
  return <><span
    ref={textRef}
    tabIndex={disabled ? undefined : 0}
    title={disabled ? value : `${value || placeholder} · Double-click to rename`}
    aria-label={label ? `${label}: ${value}` : undefined}
    data-testid={testId}
    data-editable-name=""
    className={cn("min-w-0 cursor-default truncate rounded-sm px-1 text-[13px] leading-6 outline-none select-none focus-visible:bg-background/60 focus-visible:ring-1 focus-visible:ring-ring/60", !value && "text-muted-foreground", className)}
    onDoubleClick={(event) => { if (disabled) return; event.stopPropagation(); setEditing(true); }}
    onPointerUp={onTap}
    onKeyDown={(event) => {
      if (disabled || event.nativeEvent.isComposing) return;
      if (event.key === "F2" || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); setEditing(true); }
    }}
  >{value || placeholder}</span><span className="min-w-0 flex-1" aria-hidden /></>;
}
