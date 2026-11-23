import { recordSessionTrailEvent, SessionTrailEventKind } from "@haptic/core";
import type { FeatureTestCheckReport, FeatureTestCheckResources } from "../services/feature-test-check";
import { forgetSessionTrails, sessionTrailPage, unclosedSessionTrails } from "./session-trail-record";

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
  /** The session trail page the check runs in (`sessionTrailPage`), whose trail tells why it stopped. */
  page?: string;
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
  } catch (error) {
    // Storage full or unavailable: the check still runs, it only cannot survive a crash. The session trail, a small
    // record of its own, tells the next report.
    const name = error instanceof Error ? error.name : "an error";
    recordSessionTrailEvent(SessionTrailEventKind.storage, `the Feature Test Check's record (${key}) could not be saved: ${name}`);
  }
}

/** The session trail page an unfinished check's stored record names, whichever build wrote it; null without one. */
export function unfinishedCheckPage(): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as { page?: unknown } | null;
    return typeof stored?.page === "string" ? stored.page : null;
  } catch {
    return null;
  }
}

/**
 * `report` with the pages that stopped without closing (`unclosedSessionTrails`): a check's own page when the app
 * stopped during it, and any other since the last report that told of them, such as an ordinary Play session that
 * froze. `forget` removes their records: the report of a check that ran to its end is the one that tells of them.
 */
export function withStoppedSessions(report: FeatureTestCheckReport, forget = false): FeatureTestCheckReport {
  // An unfinished check's own page is told whatever its trail ends with: a reload of ours ends it as a close.
  const trails = unclosedSessionTrails(report.unfinished?.page);
  if (forget) forgetSessionTrails(trails.map((trail) => trail.page));
  if (!trails.length) return report;
  return {
    ...report,
    stoppedSessions: trails.map((trail) => ({
      page: trail.page, lastAliveAt: trail.alive, marks: trail.marks, events: trail.events,
      ...(trail.failedWrites ? { failedWrites: trail.failedWrites } : {}),
    })),
  };
}

let savedChars: number | null = null;

/** Keeps the running check's record, naming this page's session trail (`sessionTrailPage`). */
export function saveUnfinishedCheck(check: UnfinishedCheck): void {
  const page = sessionTrailPage();
  const text = JSON.stringify({ ...check, ...(page ? { page } : {}), build: checkRecordBuild() } satisfies StoredCheck);
  savedChars = text.length;
  write(KEY, text);
}

/** The length of the running check's record as last written (`saveUnfinishedCheck`), or null before the first. */
export function unfinishedCheckChars(): number | null {
  return savedChars;
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
 * A kept record: this build's report, or another build's record (`build` names it, `unnamed` when it named none) with its
 * report, null when it holds none this build can read; `stored` is the record as it was stored (indented when JSON).
 */
export type SavedCheckRecord =
  | { kind: "this build"; report: FeatureTestCheckReport; stored: string }
  | OtherBuildCheck;

/** A record another build wrote (`SavedCheckRecord`). */
export type OtherBuildCheck = { kind: "other build"; build: string; report: FeatureTestCheckReport | null; stored: string };

/** The report a stored record holds, with its unfinished step and samples, or null when it holds none this build reads. */
function storedReport(check: Partial<UnfinishedCheck & FinishedCheck>): FeatureTestCheckReport | null {
  if (!check.report || !Array.isArray(check.report.scenes)) return null;
  if (check.finished === true) return withStoppedSessions(check.report);
  if (typeof check.step !== "string") return null;
  return withStoppedSessions({
    ...check.report,
    unfinished: {
      step: check.step, resources: Array.isArray(check.resources) ? check.resources : [],
      ...(typeof check.page === "string" ? { page: check.page } : {}),
    },
  });
}

/**
 * The record kept here: a check the app stopped during (with its last step and samples in `unfinished`), or a finished
 * one waiting to be shown; null when none was left. A record another build wrote stays until a new Check starts or the
 * user clears it, whatever this build makes of it: a deploy can land while a long Check runs on a device, and the page
 * that reloads after a crash then runs the new build. Only a record of this build that it cannot read is discarded.
 */
export function loadSavedCheckRecord(): SavedCheckRecord | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let check: (Partial<UnfinishedCheck & FinishedCheck> & { build?: unknown }) | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") check = parsed as Partial<UnfinishedCheck & FinishedCheck> & { build?: unknown };
  } catch {
    // Not JSON: no build to tell, so kept as text.
  }
  const report = check ? storedReport(check) : null;
  if (check?.build === checkRecordBuild()) {
    if (report) return { kind: "this build", report, stored: JSON.stringify(check, null, 2) };
    clearUnfinishedCheck();
    return null;
  }
  const build = typeof check?.build === "string" ? check.build : "unnamed";
  return { kind: "other build", build, report, stored: check ? JSON.stringify(check, null, 2) : raw };
}

/** This build's report kept here (`loadSavedCheckRecord`), or null: none, or another build's. */
export function loadSavedCheck(): FeatureTestCheckReport | null {
  const saved = loadSavedCheckRecord();
  return saved?.kind === "this build" ? saved.report : null;
}

/**
 * The text the dialog shows for a record another build wrote: a first line saying so, then the report as this build
 * formats it (`format`), or, when it holds none this build reads or `format` throws on it, the record as stored. The
 * report is null when the text is the stored record.
 */
export function formatOtherBuildCheck(
  saved: OtherBuildCheck, format: (report: FeatureTestCheckReport) => string,
): { text: string; report: FeatureTestCheckReport | null } {
  const note = `Written by another build of the editor (${saved.build}): this build may misread it.`;
  if (saved.report) {
    try {
      return { text: `${note}\n${format(saved.report)}`, report: saved.report };
    } catch (error) {
      console.warn("[editor] this build could not format a saved Feature Test Check report of another build", error);
      return { text: `${note}\nThis build could not format it; the stored record follows.\n${saved.stored}`, report: null };
    }
  }
  return { text: `${note}\nThis build could not read it; the stored record follows.\n${saved.stored}`, report: null };
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
