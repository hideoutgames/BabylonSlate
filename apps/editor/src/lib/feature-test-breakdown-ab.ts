import type { ProjectFolderHandle } from "@haptic/core";
import {
  isBreakdownBaseline,
  livePreserve,
  type FeatureTestBreakdownInfo,
  type FeatureTestCheckReport,
} from "../services/feature-test-check";
import { annotateSavedCheck, loadSavedCheck, saveFinishedCheck } from "./feature-test-check-record";

/**
 * The Breakdown's preserveDrawingBuffer A/B. The attribute is fixed when the project Engine is created, so after the
 * first pass the dialog stores that pass and a resume marker here, switches the stored setting and reloads the editor;
 * Home reopens the project, the dialog measures the same scenes again and writes one report of both passes, and the
 * user's setting is stored again.
 */
const KEY = "haptic:feature-test-check:breakdown-resume";
const VERSION = 1;
/** A marker older than this is stale: the reload and reopen it waits for take a minute or two. */
export const BREAKDOWN_RESUME_MAX_AGE_MS = 30 * 60_000;

/**
 * Where the second pass stands: `reload` until Home picks it up after the reload, `reopen` while Home reopens the
 * project, `second-pass` once the dialog measures. A marker found past `reload` when the editor loads means the attempt
 * stopped part-way (a crash or another reload), so it is not retried.
 */
export type BreakdownResumeStage = "reload" | "reopen" | "second-pass";

export type BreakdownProject = ProjectFolderHandle & { label: string };

export interface BreakdownResumeMarker {
  version: typeof VERSION;
  stage: BreakdownResumeStage;
  /** When the first pass ended (`Date.now()`). */
  savedAt: number;
  /** The Homepage entry to reopen after the reload. */
  project: BreakdownProject;
  /** The scenes both passes measure. */
  scenes: { name: string; path: string }[];
  /** The stored preserveDrawingBuffer setting before the A/B, stored again after it. */
  originalPreserve: boolean;
  /** The first pass's report. */
  first: FeatureTestCheckReport;
}

export interface BreakdownAbDeps {
  /** The stored preserveDrawingBuffer setting (`preserveDrawingBufferSetting`) and its setter. */
  preserve: () => boolean;
  setPreserve: (enabled: boolean) => void;
  now: () => number;
}

const STAGES: readonly BreakdownResumeStage[] = ["reload", "reopen", "second-pass"];
const onOff = (enabled: boolean) => (enabled ? "on" : "off");

function saveMarker(marker: BreakdownResumeMarker): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(marker));
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function clearBreakdownResume(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Unavailable storage holds no marker.
  }
}

type MarkerRead =
  | { kind: "none" }
  | { kind: "valid"; marker: BreakdownResumeMarker }
  | { kind: "invalid"; reason: "corrupt" | "stale"; originalPreserve: boolean | null; first: FeatureTestCheckReport | null };

const isText = (value: unknown): value is string => typeof value === "string";

function isBreakdownReport(value: unknown): value is FeatureTestCheckReport & { breakdown: FeatureTestBreakdownInfo } {
  const report = value as Partial<FeatureTestCheckReport> | null;
  return Boolean(report && Array.isArray(report.scenes) && Array.isArray(report.pageErrors)
    && Array.isArray(report.breakdown?.passes) && Array.isArray(report.breakdown?.notes));
}

function readMarker(now: number): MarkerRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { kind: "none" };
  }
  if (raw === null) return { kind: "none" };
  let value: Partial<BreakdownResumeMarker> | null;
  try {
    value = JSON.parse(raw) as Partial<BreakdownResumeMarker> | null;
  } catch {
    return { kind: "invalid", reason: "corrupt", originalPreserve: null, first: null };
  }
  const originalPreserve = typeof value?.originalPreserve === "boolean" ? value.originalPreserve : null;
  const first = isBreakdownReport(value?.first) ? value.first : null;
  const project = value?.project;
  const valid = value?.version === VERSION && STAGES.includes(value.stage as BreakdownResumeStage)
    && typeof value.savedAt === "number" && originalPreserve !== null && first !== null
    && isText(project?.id) && isText(project?.name) && isText(project?.tier) && isText(project?.label)
    && Array.isArray(value.scenes) && value.scenes.length > 0 && value.scenes.every((scene) => isText(scene?.name) && isText(scene?.path));
  if (!valid) return { kind: "invalid", reason: "corrupt", originalPreserve, first };
  const marker = value as BreakdownResumeMarker;
  const age = now - marker.savedAt;
  if (age < 0 || age > BREAKDOWN_RESUME_MAX_AGE_MS) return { kind: "invalid", reason: "stale", originalPreserve, first };
  return { kind: "valid", marker };
}

function withNotes(report: FeatureTestCheckReport, notes: readonly string[]): FeatureTestCheckReport {
  const breakdown = report.breakdown;
  return breakdown ? { ...report, breakdown: { ...breakdown, notes: [...breakdown.notes, ...notes] } } : report;
}

/** The note that the user's setting is stored again: the live Engine keeps the switched one until it is next created. */
export function restoredNote(original: boolean): string {
  return `preserveDrawingBuffer is stored as ${onOff(original)} again, as before the A/B; it applies when the editor next reloads or the project is reopened.`;
}

/**
 * After the first pass: either the marker for the second (stored, with the setting switched; the caller reloads the
 * editor) or the finished one-pass report with why there is no second pass.
 */
export function planSecondPass(
  first: FeatureTestCheckReport,
  context: { project: BreakdownProject | null; scenes: readonly { name: string; path: string }[] },
  deps: BreakdownAbDeps,
): { kind: "reload"; marker: BreakdownResumeMarker } | { kind: "done"; report: FeatureTestCheckReport } {
  const onePass = (reason: string) => ({ kind: "done" as const, report: withNotes(first, [`The preserveDrawingBuffer A/B ran one pass: ${reason}.`]) });
  if (!first.breakdown?.passes.length) return { kind: "done", report: first };
  const original = first.breakdown.passes[0]!.preserveDrawingBuffer;
  if (first.cancelled) return onePass("the first was cancelled");
  if (!first.scenes.some((scene) => scene.play.benchmark.some(isBreakdownBaseline))) return onePass("the first measured no baseline");
  if (livePreserve(first.scenes) === "n/a") return onePass("WebGPU has no preserveDrawingBuffer");
  if (!context.project) return onePass("the open project was not found in the project list, to reopen after a reload");
  const marker: BreakdownResumeMarker = {
    version: VERSION, stage: "reload", savedAt: deps.now(), project: context.project,
    scenes: context.scenes.map(({ name, path }) => ({ name, path })), originalPreserve: original, first,
  };
  if (!saveMarker(marker)) return onePass("browser storage could not keep the first pass across a reload");
  deps.setPreserve(!original);
  if (deps.preserve() !== !original) {
    clearBreakdownResume();
    deps.setPreserve(original);
    return onePass("browser storage could not store the switched setting");
  }
  return { kind: "reload", marker };
}

/** The reload did not happen (cancelled, or the browser kept the page): the setting is stored back, the first pass is the report. */
export function cancelPlannedReload(marker: BreakdownResumeMarker, reason: string, deps: BreakdownAbDeps): FeatureTestCheckReport {
  deps.setPreserve(marker.originalPreserve);
  clearBreakdownResume();
  return withNotes(marker.first, [`The preserveDrawingBuffer A/B ran one pass: ${reason}.`]);
}

/**
 * Gives up the second pass: stores the user's setting again, drops the marker and keeps the report of what completed
 * for the dialog to show when it next opens (a second pass the app stopped during already left both passes as its
 * unfinished check, which gets the notes). Returns why, for the caller to say.
 */
export function abandonSecondPass(marker: Pick<BreakdownResumeMarker, "stage" | "originalPreserve" | "first">, reason: string, deps: BreakdownAbDeps): string {
  deps.setPreserve(marker.originalPreserve);
  clearBreakdownResume();
  const notes = [`The second pass did not finish: ${reason}.`, restoredNote(marker.originalPreserve)];
  if (marker.stage === "second-pass" && loadSavedCheck()?.unfinished) for (const note of notes) annotateSavedCheck(note);
  else saveFinishedCheck(withNotes(marker.first, notes));
  return reason;
}

export type BreakdownResumeAction =
  | { kind: "none" }
  | { kind: "reopen"; marker: BreakdownResumeMarker; project: BreakdownProject }
  /** `reported`: the report of what completed waits in the check dialog. */
  | { kind: "abandoned"; reason: string; reported: boolean };

/**
 * When the editor loads (Home): what to do with a resume marker. A `reload` marker for a listed project moves to
 * `reopen` (the caller reopens the project); a stale or unreadable marker, a marker from an attempt that stopped
 * part-way, or a project that is gone abandons the second pass.
 */
export function resumeAfterLoad(listed: readonly BreakdownProject[], deps: BreakdownAbDeps): BreakdownResumeAction {
  const read = readMarker(deps.now());
  if (read.kind === "none") return { kind: "none" };
  const abandon = (marker: Parameters<typeof abandonSecondPass>[0], reason: string): BreakdownResumeAction =>
    ({ kind: "abandoned", reason: abandonSecondPass(marker, reason, deps), reported: true });
  if (read.kind === "invalid") {
    const reason = read.reason === "stale" ? "the reload it waited for was too long ago" : "its saved state was unreadable";
    if (read.first && read.originalPreserve !== null) return abandon({ stage: "reload", originalPreserve: read.originalPreserve, first: read.first }, reason);
    clearBreakdownResume();
    if (read.originalPreserve !== null) deps.setPreserve(read.originalPreserve);
    return { kind: "abandoned", reason, reported: false };
  }
  const { marker } = read;
  if (marker.stage === "second-pass") return abandon(marker, "the editor stopped during it");
  if (marker.stage === "reopen") return abandon(marker, "the editor stopped while reopening the project");
  const project = listed.find((entry) => entry.id === marker.project.id);
  if (!project) return abandon(marker, `${marker.project.label} is no longer in the project list`);
  const reopening: BreakdownResumeMarker = { ...marker, stage: "reopen" };
  if (!saveMarker(reopening)) return abandon(marker, "browser storage could not record the resume");
  return { kind: "reopen", marker: reopening, project };
}

/**
 * When the check dialog mounts in a reopened project: the marker to measure the second pass for, now at
 * `second-pass`; null when none waits for this project.
 */
export function beginSecondPass(projectId: string | null, deps: BreakdownAbDeps): BreakdownResumeMarker | null {
  const read = readMarker(deps.now());
  if (read.kind !== "valid" || read.marker.stage !== "reopen") return null;
  if (projectId !== null && projectId !== read.marker.project.id) return null;
  const marker: BreakdownResumeMarker = { ...read.marker, stage: "second-pass" };
  saveMarker(marker);
  return marker;
}

/** The second pass's Breakdown context: the first's, with a pass at the switched setting. */
export function secondPassInfo(marker: BreakdownResumeMarker): FeatureTestBreakdownInfo {
  const info = marker.first.breakdown!;
  return { ...info, passes: [...info.passes, { preserveDrawingBuffer: !marker.originalPreserve }], notes: [...info.notes] };
}

/** One report of both passes: the first pass's scenes, then the second's, under the second's Breakdown context. */
export function mergeBreakdownPasses(first: FeatureTestCheckReport, second: FeatureTestCheckReport): FeatureTestCheckReport {
  return {
    ...second,
    startedAt: first.startedAt,
    durationMs: first.durationMs + second.durationMs,
    scenes: [...first.scenes, ...second.scenes],
    pageErrors: [...first.pageErrors, ...second.pageErrors],
    breakdown: second.breakdown ?? first.breakdown,
  };
}

/** After the second pass (finished or cancelled): the user's setting stored again, the marker dropped, one report of both. */
export function finishSecondPass(marker: BreakdownResumeMarker, second: FeatureTestCheckReport, deps: BreakdownAbDeps): FeatureTestCheckReport {
  deps.setPreserve(marker.originalPreserve);
  clearBreakdownResume();
  return withNotes(mergeBreakdownPasses(marker.first, second), [restoredNote(marker.originalPreserve)]);
}
