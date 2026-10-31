import type { FeatureTestCheckReport, FeatureTestCheckResources } from "../services/feature-test-check";

/**
 * The running check's report, kept in this browser after every step and resource sample, so a check the app stops
 * during (a crash, an out-of-memory reload) still leaves its report and the step it reached. A finished report the
 * dialog could not show (a Breakdown whose second pass could not resume after its reload) is kept here too.
 */
const KEY = "haptic:feature-test-check:unfinished";
/** When the last check of any mode ended (`Date.now()`), for the Breakdown's warm-device note. */
const ENDED_KEY = "haptic:feature-test-check:ended";
/** About two minutes of samples at the dialog's interval. */
export const MAX_CHECK_RESOURCE_SAMPLES = 60;

interface UnfinishedCheck {
  step: string;
  report: FeatureTestCheckReport;
  resources: FeatureTestCheckResources[];
}

interface FinishedCheck {
  finished: true;
  report: FeatureTestCheckReport;
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage full or unavailable: the check still runs, it only cannot survive a crash.
  }
}

export function saveUnfinishedCheck(check: UnfinishedCheck): void {
  write(KEY, JSON.stringify(check));
}

/** Keeps a finished report for the dialog to show when it next opens. */
export function saveFinishedCheck(report: FeatureTestCheckReport): void {
  write(KEY, JSON.stringify({ finished: true, report } satisfies FinishedCheck));
}

export function clearUnfinishedCheck(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Unavailable storage holds nothing to clear.
  }
}

/**
 * The report kept here: a check the app stopped during (with its last step and samples in `unfinished`), or a
 * finished one waiting to be shown; null when none was left.
 */
export function loadSavedCheck(): FeatureTestCheckReport | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const check = JSON.parse(raw) as Partial<UnfinishedCheck> & Partial<FinishedCheck>;
    if (!check.report || !Array.isArray(check.report.scenes)) return null;
    if (check.finished === true) return check.report;
    if (typeof check.step !== "string") return null;
    return { ...check.report, unfinished: { step: check.step, resources: Array.isArray(check.resources) ? check.resources : [] } };
  } catch {
    return null;
  }
}

/** Adds `note` to the kept report's Breakdown notes, keeping it unfinished or finished as it was; false when none is kept. */
export function annotateSavedCheck(note: string): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const check = JSON.parse(raw) as { report?: FeatureTestCheckReport };
    const breakdown = check.report?.breakdown;
    if (!breakdown || !Array.isArray(breakdown.notes)) return false;
    breakdown.notes.push(note);
    write(KEY, JSON.stringify(check));
    return true;
  } catch {
    return false;
  }
}

export function saveCheckEnded(at: number): void {
  write(ENDED_KEY, String(at));
}

/** When the last check ended, or null when unknown. */
export function loadCheckEnded(): number | null {
  try {
    const value = Number(localStorage.getItem(ENDED_KEY) ?? "");
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
