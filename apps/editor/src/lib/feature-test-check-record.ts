import type { FeatureTestCheckReport, FeatureTestCheckResources } from "../services/feature-test-check";

/**
 * The running check's report, kept in this browser after every step and resource sample, so a check the app stops
 * during (a crash, an out-of-memory reload) still leaves its report and the step it reached.
 */
const KEY = "haptic:feature-test-check:unfinished";
/** About two minutes of samples at the dialog's interval. */
export const MAX_CHECK_RESOURCE_SAMPLES = 60;

interface UnfinishedCheck {
  step: string;
  report: FeatureTestCheckReport;
  resources: FeatureTestCheckResources[];
}

export function saveUnfinishedCheck(check: UnfinishedCheck): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(check));
  } catch {
    // Storage full or unavailable: the check still runs, it only cannot survive a crash.
  }
}

export function clearUnfinishedCheck(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Unavailable storage holds nothing to clear.
  }
}

/** The report of a check the app stopped during, with its last step and samples; null when none was left. */
export function loadUnfinishedCheck(): FeatureTestCheckReport | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const check = JSON.parse(raw) as Partial<UnfinishedCheck>;
    if (!check.report || !Array.isArray(check.report.scenes) || typeof check.step !== "string") return null;
    return { ...check.report, unfinished: { step: check.step, resources: Array.isArray(check.resources) ? check.resources : [] } };
  } catch {
    return null;
  }
}
