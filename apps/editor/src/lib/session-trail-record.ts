import {
  markSessionTrail, recordSessionTrailEvent, sessionTrail, sessionTrailEvents, SessionTrailEventKind, setSessionTrailSink,
  type SessionTrailEvent, type SessionTrailMark,
} from "@haptic/core";

/**
 * Keeps each page's session trail (`@haptic/core`) in this browser, where it outlives a page that freezes or is
 * killed, and finds the trails of pages that stopped without closing.
 *
 * Every page writes its own record, under its own key, at every mark and event and every `SESSION_TRAIL_ALIVE_MS` while
 * it runs. A page that is put away or closed in the ordinary way ends its trail with `SESSION_TRAIL_HIDDEN` or
 * `SESSION_TRAIL_CLOSED`. A record of another page that ends otherwise and has not been renewed for
 * `SESSION_TRAIL_STALE_MS` is of a page that froze, crashed or was force closed; one still being renewed is another
 * tab that is running. One that ended in the ordinary way after a stop event of ours (`SESSION_TRAIL_STOP_KINDS`: a
 * reload, a failed chunk import, an error screen) is told too: that close was the editor's own doing.
 */
const PREFIX = "haptic:session-trail:";
/** How often a running page renews its record. */
export const SESSION_TRAIL_ALIVE_MS = 5_000;
/** A record this old was not renewed by a running page (three missed renewals). */
export const SESSION_TRAIL_STALE_MS = 15_000;
/** How long a record nothing reported is kept. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1_000;
/** The last mark of a page put away (a hidden tab, a backgrounded app) or closed. */
export const SESSION_TRAIL_HIDDEN = "page: hidden";
export const SESSION_TRAIL_CLOSED = "page: closed";

/** Events that say the editor itself stopped or reloaded the page, or showed it could not go on. */
export const SESSION_TRAIL_STOP_KINDS: ReadonlySet<string> = new Set([
  SessionTrailEventKind.chunk, SessionTrailEventKind.reload, SessionTrailEventKind.errorScreen,
  SessionTrailEventKind.contextLost, SessionTrailEventKind.worker,
]);

/** One page's trail as stored: when the page last renewed it, its marks, oldest first, and its events. */
export interface StoredSessionTrail {
  page: string;
  alive: number;
  marks: SessionTrailMark[];
  events: SessionTrailEvent[];
  /** Writes of this trail that failed (storage full or unavailable) before the last that got through; absent when none. */
  failedWrites?: number;
}

/** What the page tells the record of its lifecycle. */
export interface SessionTrailPageWatch {
  /** `pagehide`; `detail` says whether the page may be kept (`persisted`) and whose reload it was. */
  closed(detail: string): void;
  visible(isVisible: boolean): void;
  /** `beforeunload`: a reload or navigation was asked for. */
  unloading(): void;
}

/** What the record needs of its host; the browser's by default. */
export interface SessionTrailHost {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Reports the page's close, visibility changes and unloading to `watch`; returns what stops it. */
  watchPage(watch: SessionTrailPageWatch): () => void;
  newPageId(): string;
}

function browserHost(): SessionTrailHost {
  return {
    storage: localStorage,
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    watchPage: (watch) => {
      const onPageHide = (event: PageTransitionEvent) => {
        // Set by `coi-serviceworker.js` when its isolation reload has begun.
        const isolation = (window as { coiReloading?: boolean }).coiReloading ? ", the isolation service worker's reload" : "";
        watch.closed(`pagehide, persisted ${event.persisted}${isolation}`);
      };
      const onVisibility = () => watch.visible(document.visibilityState !== "hidden");
      const onBeforeUnload = () => watch.unloading();
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onBeforeUnload);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("beforeunload", onBeforeUnload);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    newPageId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function isEvent(event: Partial<SessionTrailEvent> | null): event is SessionTrailEvent {
  return typeof event?.at === "number" && typeof event.first === "number" && typeof event.kind === "string"
    && typeof event.detail === "string" && typeof event.count === "number";
}

function readAll(storage: SessionTrailHost["storage"]): StoredSessionTrail[] {
  const trails: StoredSessionTrail[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const stored = JSON.parse(storage.getItem(key) ?? "") as Partial<StoredSessionTrail>;
      if (typeof stored.alive !== "number" || !Array.isArray(stored.marks)) continue;
      // Trails outlive a deploy on purpose (a crash, then an update); a mark another build wrote keeps only what is read.
      const marks = stored.marks.filter((mark: Partial<SessionTrailMark> | null) => typeof mark?.at === "number" && typeof mark.stage === "string");
      const events = Array.isArray(stored.events) ? stored.events.filter(isEvent) : [];
      const failedWrites = typeof stored.failedWrites === "number" && stored.failedWrites > 0 ? { failedWrites: stored.failedWrites } : {};
      trails.push({ page: key.slice(PREFIX.length), alive: stored.alive, marks, events, ...failedWrites });
    } catch {
      // A record this build cannot read tells nothing.
    }
  }
  return trails;
}

/** Whether the trail's page was put away or closed in the ordinary way. */
function endedOrdinarily(trail: StoredSessionTrail): boolean {
  const last = trail.marks.at(-1)?.stage;
  return last === SESSION_TRAIL_HIDDEN || last === SESSION_TRAIL_CLOSED;
}

/** Whether the trail holds an event of the editor's own stopping (`SESSION_TRAIL_STOP_KINDS`). */
function stoppedItself(trail: StoredSessionTrail): boolean {
  return trail.events.some((event) => SESSION_TRAIL_STOP_KINDS.has(event.kind));
}

let current: { page: string; host: SessionTrailHost } | null = null;

/**
 * Starts keeping this page's trail: marks the start, the page's visibility changes and its close, records the page's
 * lifecycle events and renewals that came late, and renews the record while the page runs. Records of pages that
 * ended in the ordinary way, and old ones, are removed. Returns what stops it (tests).
 */
export function startSessionTrail(host: SessionTrailHost = browserHost(), keepPage: () => string | null = () => null): () => void {
  const page = host.newPageId();
  const key = PREFIX + page;
  let failedWrites = 0;
  const write = () => {
    try {
      host.storage.setItem(key, JSON.stringify({
        alive: host.now(), marks: sessionTrail(), events: sessionTrailEvents(), ...(failedWrites ? { failedWrites } : {}),
      }));
    } catch {
      // Storage full or unavailable: the app runs, it only cannot say where it stopped. A later write that gets
      // through says how many did not, so a report can tell a trail that stopped being written from a page that stopped.
      failedWrites += 1;
    }
  };
  try {
    const now = host.now();
    // An unfinished check's page is kept for its report, however it ended.
    const kept = keepPage();
    for (const trail of readAll(host.storage)) {
      const stale = now - trail.alive >= SESSION_TRAIL_STALE_MS;
      if (trail.page === kept) continue;
      if ((stale && endedOrdinarily(trail) && !stoppedItself(trail)) || now - trail.alive >= KEEP_MS) host.storage.removeItem(PREFIX + trail.page);
    }
  } catch {
    // Unavailable storage holds nothing to remove.
  }
  current = { page, host };
  setSessionTrailSink(write);
  markSessionTrail("app: started");
  let visible = true;
  let renewed = host.now();
  const renewal = host.setInterval(() => {
    const now = host.now();
    const late = now - renewed;
    renewed = now;
    // A hidden page's timers are throttled; a visible one that renews this late did not run (a hang, a long stall).
    if (visible && late >= 2 * SESSION_TRAIL_ALIVE_MS) {
      recordSessionTrailEvent(SessionTrailEventKind.stall, `the page did not run for ${Math.round(late / 1_000)} s`);
    }
    write();
  }, SESSION_TRAIL_ALIVE_MS);
  const unwatch = host.watchPage({
    closed: (detail) => {
      recordSessionTrailEvent(SessionTrailEventKind.page, `closed (${detail})`);
      markSessionTrail(SESSION_TRAIL_CLOSED);
    },
    visible: (isVisible) => {
      visible = isVisible;
      renewed = host.now();
      if (!isVisible) recordSessionTrailEvent(SessionTrailEventKind.page, "hidden");
      markSessionTrail(isVisible ? "page: visible" : SESSION_TRAIL_HIDDEN);
    },
    unloading: () => recordSessionTrailEvent(SessionTrailEventKind.page, "unloading (beforeunload: a reload or navigation)"),
  });
  return () => {
    host.clearInterval(renewal);
    unwatch();
    setSessionTrailSink(null);
    current = null;
  };
}

/** This page's id in the stored trails, or null before `startSessionTrail`. */
export function sessionTrailPage(): string | null {
  return current?.page ?? null;
}

/**
 * The trails of pages that stopped (a freeze, a crash, a force close, or a reload of the editor's own), oldest first:
 * not this page's, not renewed for `SESSION_TRAIL_STALE_MS`, and either not ended by a hidden or closed mark or holding
 * a stop event of ours (`SESSION_TRAIL_STOP_KINDS`). `include` names a page told whatever its trail holds: an
 * unfinished Check's, which stopped. Empty before `startSessionTrail`.
 */
export function unclosedSessionTrails(include?: string): StoredSessionTrail[] {
  if (!current) return [];
  const { page, host } = current;
  try {
    const now = host.now();
    return readAll(host.storage)
      .filter((trail) => trail.page !== page && (trail.page === include
        || (now - trail.alive >= SESSION_TRAIL_STALE_MS && (!endedOrdinarily(trail) || stoppedItself(trail)))))
      .sort((a, b) => a.alive - b.alive);
  } catch {
    return [];
  }
}

/** Removes the records of `pages`, once a report has told what they held. */
export function forgetSessionTrails(pages: readonly string[]): void {
  if (!current) return;
  for (const page of pages) {
    try {
      current.host.storage.removeItem(PREFIX + page);
    } catch {
      // Unavailable storage holds nothing to remove.
    }
  }
}
