/**
 * The session trail: the last stages the app passed through (Play starting and stopping, a quality change being
 * prepared, a lost graphics context), each kept the moment it is marked. A page that freezes or is killed cannot say
 * where it was; the trail its host stored can, the next time the app starts.
 *
 * Marks are for phase boundaries, never for frames: each one is handed to the host's sink at once, which writes it
 * where it outlives the page.
 */

/** One stage, and when it was marked (`Date.now()`). */
export interface SessionTrailMark {
  at: number;
  stage: string;
}

/** Marks kept: enough for a Play session's start, a sweep of quality changes and its stop. */
export const SESSION_TRAIL_MARKS = 60;

type SessionTrailSink = (marks: readonly SessionTrailMark[]) => void;

let marks: SessionTrailMark[] = [];
let sink: SessionTrailSink | null = null;
/** Where each kept status sits in `marks`, by its key. */
const statuses = new Map<string, SessionTrailMark>();

function publish(): void {
  try {
    sink?.(marks);
  } catch {
    // A trail that cannot be stored must not stop what it describes.
  }
}

/**
 * Where the trail is kept from now on (null: nowhere). The host installs it once, at startup; the trail so far is
 * handed over at once.
 */
export function setSessionTrailSink(next: SessionTrailSink | null): void {
  sink = next;
  if (next) publish();
}

/** Marks a stage the app reached. */
export function markSessionTrail(stage: string): void {
  marks.push({ at: Date.now(), stage });
  if (marks.length > SESSION_TRAIL_MARKS) {
    const dropped = marks.shift();
    for (const [key, mark] of statuses) if (mark === dropped) statuses.delete(key);
  }
  publish();
}

/**
 * Marks a stage that repeats (a running session's heartbeat): the latest mark of `key` replaces the one before it
 * instead of pushing the stages around it out, and moves to the end of the trail.
 */
export function markSessionTrailStatus(key: string, stage: string): void {
  const previous = statuses.get(key);
  if (previous) marks = marks.filter((mark) => mark !== previous);
  markSessionTrail(stage);
  statuses.set(key, marks.at(-1)!);
}

/** The trail so far, oldest first. */
export function sessionTrail(): readonly SessionTrailMark[] {
  return marks;
}

/** Forgets the trail and its sink (tests). */
export function resetSessionTrail(): void {
  marks = [];
  sink = null;
  statuses.clear();
}
