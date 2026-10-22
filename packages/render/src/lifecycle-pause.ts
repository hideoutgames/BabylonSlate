export type LifecyclePauseHandler = (paused: boolean) => void;

/** Keep native inactivity and browser visibility as independent pause sources. */
export function attachLifecyclePause(
  handler: LifecyclePauseHandler,
  host: EventTarget = window,
  visibility: EventTarget & { visibilityState: string } = document,
): () => void {
  let inactive = false;
  const publish = () => handler(inactive || visibility.visibilityState === "hidden");
  const onAppState = (event: Event) => {
    const detail = (event as CustomEvent<{ isActive?: boolean }>).detail;
    if (typeof detail?.isActive !== "boolean") return;
    inactive = !detail.isActive;
    publish();
  };
  visibility.addEventListener("visibilitychange", publish);
  host.addEventListener("haptic:appstate", onAppState);
  const release = () => {
    visibility.removeEventListener("visibilitychange", publish);
    host.removeEventListener("haptic:appstate", onAppState);
  };
  try { publish(); } catch (error) { release(); throw error; }
  return release;
}
