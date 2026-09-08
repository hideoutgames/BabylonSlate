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
  host.addEventListener("babylonslate:appstate", onAppState);
  publish();
  return () => {
    visibility.removeEventListener("visibilitychange", publish);
    host.removeEventListener("babylonslate:appstate", onAppState);
  };
}
