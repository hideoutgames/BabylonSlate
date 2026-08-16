/**
 * Live mesh TRS may be written back only for an in-progress gizmo drag.
 * Spurious Babylon `onDragEnd` (attach/rebuild) must not re-dirty after Save.
 */
export function takeGizmoDragScene<T>(ref: { current: T | null }): T | null {
  const scene = ref.current;
  ref.current = null;
  return scene;
}
