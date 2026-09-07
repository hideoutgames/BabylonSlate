/** Keep continuous typing/dragging together, but separate completed UI edits. */
export function attachEditGestureBoundaries(
  endGesture: () => void,
): () => void {
  const pointers = new Set<number>();
  const pointerDown = (event: PointerEvent) => {
    if (pointers.size === 0) endGesture();
    pointers.add(event.pointerId);
  };
  const pointerUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
  };
  const keyDown = (event: KeyboardEvent) => {
    const target = event.target;
    const editing =
      target instanceof Element &&
      target.closest("input, textarea, [contenteditable='true']");
    if (
      (!editing && !event.repeat) ||
      (target instanceof HTMLInputElement && event.key === "Enter")
    )
      endGesture();
  };
  const blur = () => {
    pointers.clear();
    endGesture();
  };
  window.addEventListener("pointerdown", pointerDown, true);
  window.addEventListener("pointerup", pointerUp, true);
  window.addEventListener("pointercancel", pointerUp, true);
  window.addEventListener("focusout", endGesture);
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("blur", blur);
  return () => {
    window.removeEventListener("pointerdown", pointerDown, true);
    window.removeEventListener("pointerup", pointerUp, true);
    window.removeEventListener("pointercancel", pointerUp, true);
    window.removeEventListener("focusout", endGesture);
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("blur", blur);
  };
}
