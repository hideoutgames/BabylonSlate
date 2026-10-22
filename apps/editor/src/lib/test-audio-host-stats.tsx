import { useEffect } from "react";
import { isTestModeEnabled } from "@haptic/vfs";
import { audioStats } from "@haptic/render";

declare global {
  interface Window {
    __hapticAudioStats?: typeof audioStats;
  }
}

/** Expose AudioService stats for Playwright P16 fixtures. */
export function TestAudioHostStats() {
  useEffect(() => {
    if (!isTestModeEnabled()) return;
    window.__hapticAudioStats = audioStats;
    return () => {
      delete window.__hapticAudioStats;
    };
  }, []);
  return null;
}
