import type { FeatureTestCheckReport, FeatureTestCheckResources, FrameStats } from "../services/feature-test-check";
import { forgetSessionTrails, unclosedSessionTrails } from "./session-trail-record";

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

/**
 * `report` with the pages that stopped without closing (`unclosedSessionTrails`): a check's own page when the app
 * stopped during it, and any other since the last report that told of them, such as an ordinary Play session that
 * froze. `forget` removes their records: the report of a check that ran to its end is the one that tells of them.
 */
export function withStoppedSessions(report: FeatureTestCheckReport, forget = false): FeatureTestCheckReport {
  const trails = unclosedSessionTrails();
  if (forget) forgetSessionTrails(trails.map((trail) => trail.page));
  if (!trails.length) return report;
  return { ...report, stoppedSessions: trails.map((trail) => ({ lastAliveAt: trail.alive, marks: trail.marks })) };
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

/** Whether `stats` is null (no frames sampled) or holds every frame statistic a report reads. */
function completeFrames(stats: unknown): boolean {
  if (stats === null) return true;
  const frames = stats as Partial<FrameStats> | undefined;
  return typeof frames?.medianMs === "number" && typeof frames.meanMs === "number" && Array.isArray(frames.vsync);
}

/** Whether every scene of a stored report holds complete frame statistics, so formatting it reads no missing field. */
function completeReport(report: FeatureTestCheckReport): boolean {
  return report.scenes.every((scene) => {
    const { editor, play } = scene as Partial<typeof scene>;
    return completeFrames(editor?.frames) && completeFrames(play?.frames) &&
      Array.isArray(play?.benchmark) && play.benchmark.every((sample) => completeFrames(sample.frames));
  });
}

/**
 * The report kept here: a check the app stopped during (with its last step and samples in `unfinished`), or a
 * finished one waiting to be shown; null when none was left. A stored report this build cannot read is discarded.
 */
export function loadSavedCheck(): FeatureTestCheckReport | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const check = JSON.parse(raw) as Partial<UnfinishedCheck> & Partial<FinishedCheck>;
    if (!check.report || !Array.isArray(check.report.scenes)) return null;
    if (!completeReport(check.report)) {
      clearUnfinishedCheck();
      return null;
    }
    if (check.finished === true) return withStoppedSessions(check.report);
    if (typeof check.step !== "string") return null;
    return withStoppedSessions({ ...check.report, unfinished: { step: check.step, resources: Array.isArray(check.resources) ? check.resources : [] } });
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
