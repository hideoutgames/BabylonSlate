import { useEffect } from "react";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { particleStats } from "@babylonslate/render";

declare global {
  interface Window {
    __babylonslateParticleStats?: typeof particleStats;
  }
}

/** Expose ParticleService stats for Playwright P17 fixtures. */
export function TestParticleHostStats() {
  useEffect(() => {
    if (!isTestModeEnabled()) return;
    window.__babylonslateParticleStats = particleStats;
    return () => {
      delete window.__babylonslateParticleStats;
    };
  }, []);
  return null;
}
