/**
 * App lifecycle pause: visibilitychange + optional Capacitor app-state.
 * Callers pause render scheduler, game runtime, and encode queue together.
 */
export type LifecyclePauseHandler = (paused: boolean) => void;

export function attachLifecyclePause(
  handler: LifecyclePauseHandler,
): () => void {
  let inactive = false;
  const publish = () => handler(inactive || document.visibilityState === "hidden");
  const onVisibility = () => {
    publish();
  };
  document.addEventListener("visibilitychange", onVisibility);
  // VFS emits native events only on mobile; synchronous attachment also
  // handles events forwarded to Preview Build without importing a plugin.
  const onAppState = (event: Event) => {
    const detail = (event as CustomEvent<{ isActive?: boolean }>).detail;
    if (typeof detail?.isActive !== "boolean") return;
    inactive = !detail.isActive;
    publish();
  };
  window.addEventListener("babylonslate:appstate", onAppState);
  publish();

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("babylonslate:appstate", onAppState);
  };
}
