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
  const publishActive = () => dispatch("haptic:appstate", {
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
    dispatch("haptic:audiointerruption", interruption);
  };
  const onRoute = (event: Event) => dispatch("haptic:audioroutechange", (event as CustomEvent).detail);
  host.addEventListener("haptic:appstate", onAppState);
  host.addEventListener("haptic:audiointerruption", onInterruption);
  host.addEventListener("haptic:audioroutechange", onRoute);
  visibility.addEventListener("visibilitychange", publishActive);
  return {
    sync() {
      publishActive();
      if (interruption) dispatch("haptic:audiointerruption", interruption);
    },
    dispose() {
      host.removeEventListener("haptic:appstate", onAppState);
      host.removeEventListener("haptic:audiointerruption", onInterruption);
      host.removeEventListener("haptic:audioroutechange", onRoute);
      visibility.removeEventListener("visibilitychange", publishActive);
    },
  };
}
