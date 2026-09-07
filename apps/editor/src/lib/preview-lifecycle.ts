/** Forward native state into the same-origin Preview Build window. */
export function attachPreviewLifecycle(
  target: () => EventTarget | null,
  host: EventTarget = window,
  visibility: EventTarget & { visibilityState: string } = document,
) {
  let active = true;
  let interruption: unknown;
  const dispatch = (type: string, detail: unknown) => {
    target()?.dispatchEvent(new CustomEvent(type, { detail }));
  };
  const publishActive = () => dispatch("babylonslate:appstate", {
    isActive: active && visibility.visibilityState !== "hidden",
  });
  const onAppState = (event: Event) => {
    const detail = (event as CustomEvent<{ isActive?: boolean }>).detail;
    if (typeof detail?.isActive !== "boolean") return;
    active = detail.isActive;
    publishActive();
  };
  const onInterruption = (event: Event) => {
    interruption = (event as CustomEvent).detail;
    dispatch("babylonslate:audiointerruption", interruption);
  };
  const onRoute = (event: Event) => dispatch("babylonslate:audioroutechange", (event as CustomEvent).detail);
  host.addEventListener("babylonslate:appstate", onAppState);
  host.addEventListener("babylonslate:audiointerruption", onInterruption);
  host.addEventListener("babylonslate:audioroutechange", onRoute);
  visibility.addEventListener("visibilitychange", publishActive);
  return {
    sync() {
      publishActive();
      if (interruption) dispatch("babylonslate:audiointerruption", interruption);
    },
    dispose() {
      host.removeEventListener("babylonslate:appstate", onAppState);
      host.removeEventListener("babylonslate:audiointerruption", onInterruption);
      host.removeEventListener("babylonslate:audioroutechange", onRoute);
      visibility.removeEventListener("visibilitychange", publishActive);
    },
  };
}
