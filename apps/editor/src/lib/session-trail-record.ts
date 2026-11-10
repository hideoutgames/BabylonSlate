import { markSessionTrail, sessionTrail, setSessionTrailSink, type SessionTrailMark } from "@haptic/core";

/**
 * Keeps each page's session trail (`@haptic/core`) in this browser, where it outlives a page that freezes or is
 * killed, and finds the trails of pages that stopped without closing.
 *
 * Every page writes its own record, under its own key, at every mark and every `SESSION_TRAIL_ALIVE_MS` while it
 * runs. A page that is put away or closed in the ordinary way ends its trail with `SESSION_TRAIL_HIDDEN` or
 * `SESSION_TRAIL_CLOSED`. A record of another page that ends otherwise and has not been renewed for
 * `SESSION_TRAIL_STALE_MS` is of a page that froze, crashed or was force closed; one still being renewed is another
 * tab that is running.
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

/** One page's trail as stored: when the page last renewed it, and its marks, oldest first. */
export interface StoredSessionTrail {
  page: string;
  alive: number;
  marks: SessionTrailMark[];
}

/** What the record needs of its host; the browser's by default. */
export interface SessionTrailHost {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Calls `closed` when the page is closed and `visible` with each visibility change; returns what stops both. */
  watchPage(closed: () => void, visible: (isVisible: boolean) => void): () => void;
  newPageId(): string;
}

function browserHost(): SessionTrailHost {
  return {
    storage: localStorage,
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    watchPage: (closed, visible) => {
      const onVisibility = () => visible(document.visibilityState !== "hidden");
      window.addEventListener("pagehide", closed);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.removeEventListener("pagehide", closed);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    newPageId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function readAll(storage: SessionTrailHost["storage"]): StoredSessionTrail[] {
  const trails: StoredSessionTrail[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const stored = JSON.parse(storage.getItem(key) ?? "") as Partial<StoredSessionTrail>;
      if (typeof stored.alive !== "number" || !Array.isArray(stored.marks)) continue;
      trails.push({ page: key.slice(PREFIX.length), alive: stored.alive, marks: stored.marks });
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

let current: { page: string; host: SessionTrailHost } | null = null;

/**
 * Starts keeping this page's trail: marks the start, the page's visibility changes and its close, and renews the
 * record while the page runs. Records of pages that ended in the ordinary way, and old ones, are removed. Returns
 * what stops it (tests).
 */
export function startSessionTrail(host: SessionTrailHost = browserHost()): () => void {
  const page = host.newPageId();
  const key = PREFIX + page;
  const write = () => {
    try {
      host.storage.setItem(key, JSON.stringify({ alive: host.now(), marks: sessionTrail() }));
    } catch {
      // Storage full or unavailable: the app runs, it only cannot say where it stopped.
    }
  };
  try {
    const now = host.now();
    for (const trail of readAll(host.storage)) {
      const stale = now - trail.alive >= SESSION_TRAIL_STALE_MS;
      if ((stale && endedOrdinarily(trail)) || now - trail.alive >= KEEP_MS) host.storage.removeItem(PREFIX + trail.page);
    }
  } catch {
    // Unavailable storage holds nothing to remove.
  }
  current = { page, host };
  setSessionTrailSink(write);
  markSessionTrail("app: started");
  const renewal = host.setInterval(write, SESSION_TRAIL_ALIVE_MS);
  const unwatch = host.watchPage(
    () => markSessionTrail(SESSION_TRAIL_CLOSED),
    (isVisible) => markSessionTrail(isVisible ? "page: visible" : SESSION_TRAIL_HIDDEN),
  );
  return () => {
    host.clearInterval(renewal);
    unwatch();
    setSessionTrailSink(null);
    current = null;
  };
}

/**
 * The trails of pages that stopped without closing (a freeze, a crash, a force close), oldest first: not this page's,
 * not renewed for `SESSION_TRAIL_STALE_MS`, and not ended by a hidden or closed mark. Empty before
 * `startSessionTrail`.
 */
export function unclosedSessionTrails(): StoredSessionTrail[] {
  if (!current) return [];
  const { page, host } = current;
  try {
    const now = host.now();
    return readAll(host.storage)
      .filter((trail) => trail.page !== page && now - trail.alive >= SESSION_TRAIL_STALE_MS && !endedOrdinarily(trail))
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
