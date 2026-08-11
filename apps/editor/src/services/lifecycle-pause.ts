/**
 * App lifecycle pause: visibilitychange + optional Capacitor app-state.
 * Callers pause render scheduler, game runtime, and encode queue together.
 */
export type LifecyclePauseHandler = (paused: boolean) => void;

export function attachLifecyclePause(
  handler: LifecyclePauseHandler,
): () => void {
  const onVisibility = () => {
    handler(document.visibilityState === "hidden");
  };
  document.addEventListener("visibilitychange", onVisibility);

  let removeCapacitor: (() => void) | undefined;
  void import("@babylonslate/vfs")
    .then(({ getHostPlatform }) => {
      const platform = getHostPlatform();
      if (platform !== "ios" && platform !== "android") return;
      // Dynamic Capacitor App listener — only vfs may import plugins; here we
      // only react to a custom event the vfs layer can forward later.
      const onAppState = (event: Event) => {
        const detail = (event as CustomEvent<{ isActive?: boolean }>).detail;
        if (detail && typeof detail.isActive === "boolean") {
          handler(!detail.isActive);
        }
      };
      window.addEventListener("babylonslate:appstate", onAppState);
      removeCapacitor = () =>
        window.removeEventListener("babylonslate:appstate", onAppState);
    })
    .catch(() => {
      // vfs unavailable — visibility-only
    });

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    removeCapacitor?.();
  };
}
