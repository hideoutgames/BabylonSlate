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

  void BabylonSlateAudioLifecycle.addListener(
    "audioInterruption",
    (event: AudioLifecycleEvent) => {
      window.dispatchEvent(
        new CustomEvent<AudioLifecycleEvent>("babylonslate:audiointerruption", {
          detail: event,
        }),
      );
    },
  ).then((handle) => {
    removeInterruption = () => handle.remove();
  });

  void BabylonSlateAudioLifecycle.addListener(
    "audioRouteChange",
    (event: AudioLifecycleEvent) => {
      window.dispatchEvent(
        new CustomEvent<AudioLifecycleEvent>("babylonslate:audioroutechange", {
          detail: event,
        }),
      );
    },
  ).then((handle) => {
    removeRouteChange = () => handle.remove();
  });

  return () => {
    removeInterruption?.();
    removeRouteChange?.();
  };
}
