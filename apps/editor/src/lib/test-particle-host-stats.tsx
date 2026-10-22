import { useEffect } from "react";
import { isTestModeEnabled } from "@haptic/vfs";
import { particleStats } from "@haptic/render";

declare global {
  interface Window {
    __hapticParticleStats?: typeof particleStats;
  }
}

/** Expose ParticleService stats for Playwright P17 fixtures. */
export function TestParticleHostStats() {
  useEffect(() => {
    if (!isTestModeEnabled()) return;
    window.__hapticParticleStats = particleStats;
    return () => {
      delete window.__hapticParticleStats;
    };
  }, []);
  return null;
}
