import {
  useCallback,
  useRef,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";

type SelectableField = Pick<HTMLInputElement, "select">;

/** Select the field contents. No-ops when the control rejects selection. */
export function selectInputContents(el: SelectableField): void {
  try {
    el.select();
  } catch {
    // type=number and similar controls throw in some engines
  }
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * Select-all on first activate (click, tap, or Tab). A later gesture while
 * focused leaves the caret so a second tap can edit one character.
 */
export function useSelectAllOnActivate() {
  const pointerActivateRef = useRef(false);
  const pendingRef = useRef(false);

  const onPointerDown = useCallback(() => {
    pointerActivateRef.current = true;
  }, []);

  const onFocus = useCallback((event: FocusEvent<TextField>) => {
    pendingRef.current = pointerActivateRef.current;
    pointerActivateRef.current = false;
    selectInputContents(event.currentTarget);
  }, []);

  const reselectAfterCaret = useCallback((el: TextField) => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    queueMicrotask(() => selectInputContents(el));
    requestAnimationFrame(() => selectInputContents(el));
  }, []);

  const onPointerUp = useCallback(
    (event: PointerEvent<TextField>) => {
      reselectAfterCaret(event.currentTarget);
    },
    [reselectAfterCaret],
  );

  const onMouseUp = useCallback(
    (event: MouseEvent<TextField>) => {
      reselectAfterCaret(event.currentTarget);
    },
    [reselectAfterCaret],
  );

  const onBlur = useCallback(() => {
    pendingRef.current = false;
    pointerActivateRef.current = false;
  }, []);

  return { onFocus, onBlur, onPointerDown, onPointerUp, onMouseUp };
}
