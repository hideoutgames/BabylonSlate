import { isMobilePlatform } from "./platform";

export type AppState = { isActive: boolean };

export function initializeCapacitorLifecycle(): () => void {
  if (!isMobilePlatform()) {
    return () => {};
  }

  let removeListener: (() => void) | undefined;

  void import("@capacitor/app").then(({ App }) => {
    const handlePromise = App.addListener(
      "appStateChange",
      (state: AppState) => {
        window.dispatchEvent(
          new CustomEvent<{ isActive: boolean }>("babylonslate:appstate", {
            detail: { isActive: state.isActive },
          }),
        );
      },
    );
    removeListener = () => {
      void handlePromise.then((handle) => handle.remove());
    };
  });

  return () => {
    removeListener?.();
  };
}
