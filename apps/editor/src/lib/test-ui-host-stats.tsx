import { useEffect } from "react";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { uiHostStats } from "@babylonslate/render";

declare global {
  interface Window {
    __babylonslateUiHostStats?: typeof uiHostStats;
  }
}

/** Expose apply/create/present/commit counters for Playwright regression fixtures. */
export function TestUiHostStats() {
  useEffect(() => {
    if (!isTestModeEnabled()) return;
    window.__babylonslateUiHostStats = uiHostStats;
    return () => {
      delete window.__babylonslateUiHostStats;
    };
  }, []);
  return null;
}
