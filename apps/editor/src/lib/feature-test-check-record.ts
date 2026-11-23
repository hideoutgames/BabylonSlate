import { recordSessionTrailEvent, SessionTrailEventKind } from "@haptic/core";
import type { FeatureTestCheckReport, FeatureTestCheckResources } from "../services/feature-test-check";
import { forgetSessionTrails, sessionTrailPage, unclosedSessionTrails } from "./session-trail-record";

/**
 * The running check's report, kept in this browser after every step (its resource samples, every 2 s, in a record of
 * their own), so a check the app stops during (a crash, an out-of-memory reload) still leaves its report and the step
 * it reached. A finished report the
 * dialog could not show (a Breakdown whose second pass could not resume after its reload) is kept here too.
 */
const KEY = "haptic:feature-test-check:unfinished";
/**
 * The running check's last resource samples, apart from its report: the 2 s sampler rewrites only this small record,
 * never the report, whose size grows with the check.
 */
const SAMPLES_KEY = "haptic:feature-test-check:unfinished-samples";
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

/**
 * The parts of a row that rows repeat whole (a view's frame structures, its timer passes, the settings fingerprint, the
 * program census): stored once each in the record's `pool`, every use a `{ $pool: index }` in its place. Lossless:
 * loading (`expandPooled`) puts each back as it was.
 */
interface PooledRecord {
  report: unknown;
  pool: unknown[];
}

/** `value`, or its pool reference when it is large enough to be worth one. */
function pooled(value: unknown, pool: unknown[], seen: Map<string, number>): unknown {
  if (value === null || typeof value !== "object") return value;
  const text = JSON.stringify(value);
  if (text.length < 200) return value;
  let index = seen.get(text);
  if (index === undefined) {
    index = pool.length;
    pool.push(value);
    seen.set(text, index);
  }
  return { $pool: index };
}

type PooledSample = Record<string, unknown> & {
  gpuProbe?: { signature?: { structures?: Array<{ passes?: unknown }> } | null; timers?: { passes?: unknown } | null };
};

/** `report` with the parts its rows repeat pooled (`PooledRecord`); the report itself is not changed. */
function poolReport(report: FeatureTestCheckReport): PooledRecord {
  const pool: unknown[] = [];
  const seen = new Map<string, number>();
  const scenes = report.scenes.map((scene) => ({
    ...scene,
    play: {
      ...scene.play,
      benchmark: scene.play.benchmark.map((row) => {
        const sample = row as unknown as PooledSample;
        const probe = sample.gpuProbe;
        return {
          ...sample,
          ...(sample.settings ? { settings: pooled(sample.settings, pool, seen) } : {}),
          ...(sample.programs ? { programs: pooled(sample.programs, pool, seen) } : {}),
          ...(probe ? {
            gpuProbe: {
              ...probe,
              ...(probe.signature ? {
                signature: { ...probe.signature, structures: probe.signature.structures?.map((entry) => ({ ...entry, passes: pooled(entry.passes, pool, seen) })) },
              } : {}),
              ...(probe.timers ? { timers: { ...probe.timers, passes: pooled(probe.timers.passes, pool, seen) } } : {}),
            },
          } : {}),
        };
      }),
    },
  }));
  return { report: { ...report, scenes }, pool };
}

/** Puts every pool reference in `value` back (`poolReport`); a record without a pool is returned as it is. */
function expandPooled(value: unknown, pool: readonly unknown[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => expandPooled(entry, pool));
  if (value === null || typeof value !== "object") return value;
  const index = (value as { $pool?: unknown }).$pool;
  if (typeof index === "number" && Object.keys(value).length === 1) return expandPooled(pool[index], pool);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandPooled(entry, pool)]));
}

let savedChars: number | null = null;

/**
 * Keeps the running check's report at a step, naming this page's session trail (`sessionTrailPage`): once per step,
 * the whole report with what its rows repeat pooled. Never on a timer: the resource samples are their own record
 * (`saveUnfinishedCheckSamples`).
 */
export function saveUnfinishedCheckBody(step: string, report: FeatureTestCheckReport): void {
  const page = sessionTrailPage();
  let text: string;
  try {
    const { report: stored, pool } = poolReport(report);
    text = JSON.stringify({ step, report: stored, pool, ...(page ? { page } : {}), build: checkRecordBuild() });
  } catch (error) {
    recordSessionTrailEvent(SessionTrailEventKind.storage, `the Feature Test Check's record could not be written: ${error instanceof Error ? error.name : "an error"}`);
    return;
  }
  savedChars = text.length;
  write(KEY, text);
}

/** Keeps the running check's last resource samples (at most `MAX_CHECK_RESOURCE_SAMPLES`), apart from its report. */
export function saveUnfinishedCheckSamples(resources: readonly FeatureTestCheckResources[]): void {
  write(SAMPLES_KEY, JSON.stringify({ resources: resources.slice(-MAX_CHECK_RESOURCE_SAMPLES), build: checkRecordBuild() }));
}

/** Keeps a running check's report and samples at once (`saveUnfinishedCheckBody`, `saveUnfinishedCheckSamples`). */
export function saveUnfinishedCheck(check: Omit<UnfinishedCheck, "page">): void {
  saveUnfinishedCheckBody(check.step, check.report);
  saveUnfinishedCheckSamples(check.resources);
}

/** The length of the running check's report record as last written (`saveUnfinishedCheckBody`), or null before the first. */
export function unfinishedCheckChars(): number | null {
  return savedChars;
}

/** Keeps a finished report for the dialog to show when it next opens. */
export function saveFinishedCheck(report: FeatureTestCheckReport): void {
  const { report: stored, pool } = poolReport(report);
  write(KEY, JSON.stringify({ finished: true, report: stored, pool, build: checkRecordBuild() }));
  remove(SAMPLES_KEY);
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Unavailable storage holds nothing to clear.
  }
}

/** Removes the kept report and its samples together. */
export function clearUnfinishedCheck(): void {
  remove(KEY);
  remove(SAMPLES_KEY);
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

type LoadedCheck = Partial<UnfinishedCheck & FinishedCheck> & { build?: unknown; pool?: unknown };

/** A stored record with its pooled parts put back (`poolReport`); one without a pool as it is. */
function expanded(check: LoadedCheck): LoadedCheck {
  if (!Array.isArray(check.pool) || !check.report) return check;
  try {
    return { ...check, report: expandPooled(check.report, check.pool) as FeatureTestCheckReport };
  } catch {
    return { ...check, report: undefined };
  }
}

/**
 * An unfinished record with its resource samples (`saveUnfinishedCheckSamples`) when it holds none of its own: those
 * the same build wrote beside it.
 */
function withSamples(check: LoadedCheck): LoadedCheck {
  if (check.finished === true || Array.isArray(check.resources)) return check;
  try {
    const samples = JSON.parse(localStorage.getItem(SAMPLES_KEY) ?? "null") as { resources?: unknown; build?: unknown } | null;
    if (samples && samples.build === check.build && Array.isArray(samples.resources)) {
      return { ...check, resources: samples.resources as FeatureTestCheckResources[] };
    }
  } catch {
    // Unreadable samples: the report without them.
  }
  return check;
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
  let check: LoadedCheck | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") check = parsed as LoadedCheck;
  } catch {
    // Not JSON: no build to tell, so kept as text.
  }
  const report = check ? storedReport(withSamples(expanded(check))) : null;
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
