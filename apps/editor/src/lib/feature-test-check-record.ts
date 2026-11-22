import type { FeatureTestCheckReport, FeatureTestCheckResources } from "../services/feature-test-check";
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

/** What is stored: the check, with the build that wrote it (`checkRecordBuild`). */
type StoredCheck = (UnfinishedCheck | FinishedCheck) & { build: string };

/** A deploy's hashed entry scripts (`assets/index-<hash>.js`); a dev server's `/src/main.tsx` is none. */
const BUILD_ENTRY = /(?:^|\/)assets\/[^/]+-[\w-]{6,}\.js$/;

/**
 * The build this page runs, as the stored Check records name it: its hashed entry scripts, whose names change with
 * every deploy that changes any code (a chunk's hash covers the hashes of the chunks it imports), so a change of the
 * report's shape needs no one to remember a format number. A page without them (a dev server, tests) is one build.
 */
export function checkRecordBuild(): string {
  try {
    const entries = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
      .map((script) => script.getAttribute("src") ?? "").filter((src) => BUILD_ENTRY.test(src))
      .map((src) => src.slice(src.lastIndexOf("/") + 1));
    if (entries.length) return entries.join(" ");
  } catch {
    // No document: one build, as on a dev server.
  }
  return "development";
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
  write(KEY, JSON.stringify({ ...check, build: checkRecordBuild() } satisfies StoredCheck));
}

/** Keeps a finished report for the dialog to show when it next opens. */
export function saveFinishedCheck(report: FeatureTestCheckReport): void {
  write(KEY, JSON.stringify({ finished: true, report, build: checkRecordBuild() } satisfies StoredCheck));
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
 * finished one waiting to be shown; null when none was left. A record another build wrote, or one this build cannot
 * read, is discarded: the report's shape changes between builds, and this build's formatter would misread an older one.
 */
export function loadSavedCheck(): FeatureTestCheckReport | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const check = JSON.parse(raw) as Partial<UnfinishedCheck & FinishedCheck & { build: unknown }>;
    if (check.build === checkRecordBuild() && check.report && Array.isArray(check.report.scenes)) {
      if (check.finished === true) return withStoppedSessions(check.report);
      if (typeof check.step === "string") {
        return withStoppedSessions({ ...check.report, unfinished: { step: check.step, resources: Array.isArray(check.resources) ? check.resources : [] } });
      }
    }
  } catch {
    // Unreadable: discarded below.
  }
  clearUnfinishedCheck();
  return null;
}

/**
 * Adds `note` to the kept report's Breakdown notes, keeping it unfinished or finished as it was; false when none of
 * this build is kept.
 */
export function annotateSavedCheck(note: string): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const check = JSON.parse(raw) as { build?: unknown; report?: FeatureTestCheckReport };
    if (check.build !== checkRecordBuild()) return false;
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
