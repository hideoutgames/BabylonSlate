import type { AudioPlaybackBackend } from "./audio-playback-backend";

/** Shared by Play, the packed player, and asset previews. */
export function attachAudioLifecycle(
  backend: AudioPlaybackBackend,
  target: EventTarget | undefined = typeof window === "undefined" ? undefined : window,
  visibility: (EventTarget & { visibilityState: string }) | undefined =
    typeof document === "undefined" ? undefined : document,
) {
  let userPaused = false;
  let inactive = false;
  let interrupted = false;
  let waitingForGesture = false;
  const paused = () => userPaused || inactive || interrupted || waitingForGesture || visibility?.visibilityState === "hidden";
  const apply = () => backend.setPaused(paused());
  const recover = () => {
    apply();
    if (!paused()) backend.resumeContext();
  };
  const onInterruption = (event: Event) => {
    const detail = (event as CustomEvent<{ type?: string; shouldResume?: boolean }>).detail;
    if (detail?.type === "began") {
      interrupted = true;
      apply();
    } else if (detail?.type === "ended") {
      interrupted = false;
      waitingForGesture = detail.shouldResume === false;
      recover();
    }
  };
  const onAppState = (event: Event) => {
    const detail = (event as CustomEvent<{ isActive?: boolean }>).detail;
    if (typeof detail?.isActive !== "boolean") return;
    inactive = !detail.isActive;
    recover();
  };
  const onRouteChange = () => { if (!paused()) backend.resumeContext(); };
  target?.addEventListener("babylonslate:audiointerruption", onInterruption);
  target?.addEventListener("babylonslate:audioroutechange", onRouteChange);
  target?.addEventListener("babylonslate:appstate", onAppState);
  visibility?.addEventListener("visibilitychange", recover);
  apply();

  return {
    setPaused(value: boolean) {
      userPaused = value;
      apply();
    },
    resumeFromGesture() {
      waitingForGesture = false;
      apply();
    },
    dispose() {
      target?.removeEventListener("babylonslate:audiointerruption", onInterruption);
      target?.removeEventListener("babylonslate:audioroutechange", onRouteChange);
      target?.removeEventListener("babylonslate:appstate", onAppState);
      visibility?.removeEventListener("visibilitychange", recover);
    },
  };
}
