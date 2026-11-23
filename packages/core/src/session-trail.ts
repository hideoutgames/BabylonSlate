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

/**
 * Something that may say why a page stopped (an uncaught error, a failed chunk import, a reload of ours, an error
 * screen, a lost graphics context, the page closing), kept apart from the marks so a Check's stages cannot push it
 * out. A repeat of the same kind and detail counts on the kept one: `at` is its latest, `first` its first.
 */
export interface SessionTrailEvent {
  at: number;
  first: number;
  kind: string;
  detail: string;
  count: number;
}

/**
 * The kinds of event the app records. `page` is the page's lifecycle (closed, hidden, unloading); `stall` a renewal of
 * the stored trail that came late while the page was visible (its main thread did not run).
 */
export const SessionTrailEventKind = {
  error: "uncaught error",
  rejection: "unhandled rejection",
  resource: "resource failed to load",
  chunk: "chunk import failed",
  reload: "reload",
  errorScreen: "error screen",
  contextLost: "context lost",
  contextRestored: "context restored",
  worker: "game worker",
  page: "page",
  stall: "stall",
} as const;

/** Events kept; repeats count on their kept event. */
export const SESSION_TRAIL_EVENTS = 24;
/** An event's detail is cut to this many characters. */
const EVENT_DETAIL_CHARS = 600;

type SessionTrailSink = (marks: readonly SessionTrailMark[]) => void;

let marks: SessionTrailMark[] = [];
let events: SessionTrailEvent[] = [];
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

/**
 * Records an event (`SessionTrailEvent`). A new one is handed to the sink at once, before whatever follows can stop the
 * page; a repeat only counts in memory, so an error thrown every frame writes nothing per frame: the host's next write
 * (its renewal, or the next mark or new event) keeps the count.
 */
export function recordSessionTrailEvent(kind: string, detail: string): void {
  const text = detail.length > EVENT_DETAIL_CHARS ? `${detail.slice(0, EVENT_DETAIL_CHARS - 1)}…` : detail;
  const now = Date.now();
  const index = events.findIndex((event) => event.kind === kind && event.detail === text);
  if (index >= 0) {
    const repeat = events[index]!;
    repeat.count += 1;
    repeat.at = now;
    events.splice(index, 1);
    events.push(repeat);
    return;
  }
  events.push({ at: now, first: now, kind, detail: text, count: 1 });
  if (events.length > SESSION_TRAIL_EVENTS) events.shift();
  publish();
}

/** The trail so far, oldest first. */
export function sessionTrail(): readonly SessionTrailMark[] {
  return marks;
}

/** The events so far, by their latest occurrence, oldest first. */
export function sessionTrailEvents(): readonly SessionTrailEvent[] {
  return events;
}

/** Forgets the trail and its sink (tests). */
export function resetSessionTrail(): void {
  marks = [];
  events = [];
  sink = null;
  statuses.clear();
}
