import { useEffect } from "react";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { audioStats } from "@babylonslate/render";

declare global {
  interface Window {
    __babylonslateAudioStats?: typeof audioStats;
  }
}

/** Expose AudioService stats for Playwright P16 fixtures. */
export function TestAudioHostStats() {
  useEffect(() => {
    if (!isTestModeEnabled()) return;
    window.__babylonslateAudioStats = audioStats;
    return () => {
      delete window.__babylonslateAudioStats;
    };
  }, []);
  return null;
}
