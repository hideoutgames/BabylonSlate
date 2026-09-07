import { isMobilePlatform } from "./platform";

export type AppState = { isActive: boolean };

export function initializeCapacitorLifecycle(): () => void {
  if (!isMobilePlatform()) {
    return () => {};
  }

  let removeListener: (() => void) | undefined;
  let disposed = false;

  void import("@capacitor/app").then(async ({ App }) => {
    if (disposed) return;
    const handle = await App.addListener(
      "appStateChange",
      (state: AppState) => {
        if (disposed) return;
        window.dispatchEvent(
          new CustomEvent<{ isActive: boolean }>("babylonslate:appstate", {
            detail: { isActive: state.isActive },
          }),
        );
      },
    );
    if (disposed) {
      await handle.remove();
      return;
    }
    removeListener = () => {
      void handle.remove().catch((error: unknown) => console.warn("App lifecycle cleanup failed", error));
    };
  }).catch((error: unknown) => console.warn("Native app lifecycle unavailable", error));

  return () => {
    if (disposed) return;
    disposed = true;
    removeListener?.();
  };
}
