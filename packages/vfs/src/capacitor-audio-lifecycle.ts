import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isMobilePlatform } from "./platform";

export interface AudioLifecycleEvent {
  type: string;
  shouldResume?: boolean;
  reason?: number;
}

export interface BabylonSlateAudioLifecyclePlugin {
  addListener(
    eventName: "audioInterruption",
    listener: (event: AudioLifecycleEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "audioRouteChange",
    listener: (event: AudioLifecycleEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export const BabylonSlateAudioLifecycle =
  registerPlugin<BabylonSlateAudioLifecyclePlugin>(
    "BabylonSlateAudioLifecycle",
  );

export function initializeCapacitorAudioLifecycle(): () => void {
  if (!isMobilePlatform()) {
    return () => {};
  }

  let removeInterruption: (() => void) | undefined;
  let removeRouteChange: (() => void) | undefined;
  let disposed = false;

  void BabylonSlateAudioLifecycle.addListener(
    "audioInterruption",
    (event: AudioLifecycleEvent) => {
      if (disposed) return;
      window.dispatchEvent(
        new CustomEvent<AudioLifecycleEvent>("babylonslate:audiointerruption", {
          detail: event,
        }),
      );
    },
  ).then((handle) => {
    if (disposed) return handle.remove();
    removeInterruption = () => {
      void handle.remove().catch((error: unknown) => console.warn("Audio lifecycle cleanup failed", error));
    };
  }).catch((error: unknown) => console.warn("Native audio interruption events unavailable", error));

  void BabylonSlateAudioLifecycle.addListener(
    "audioRouteChange",
    (event: AudioLifecycleEvent) => {
      if (disposed) return;
      window.dispatchEvent(
        new CustomEvent<AudioLifecycleEvent>("babylonslate:audioroutechange", {
          detail: event,
        }),
      );
    },
  ).then((handle) => {
    if (disposed) return handle.remove();
    removeRouteChange = () => {
      void handle.remove().catch((error: unknown) => console.warn("Audio lifecycle cleanup failed", error));
    };
  }).catch((error: unknown) => console.warn("Native audio route events unavailable", error));

  return () => {
    if (disposed) return;
    disposed = true;
    removeInterruption?.();
    removeRouteChange?.();
  };
}
