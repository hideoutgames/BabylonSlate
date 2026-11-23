import { afterEach, describe, expect, it } from "vitest";
import { markSessionTrail, recordSessionTrailEvent, resetSessionTrail, type SessionTrailEvent, type SessionTrailMark } from "@haptic/core";
import {
  forgetSessionTrails, SESSION_TRAIL_ALIVE_MS, SESSION_TRAIL_CLOSED, SESSION_TRAIL_HIDDEN, SESSION_TRAIL_STALE_MS, sessionTrailPage, startSessionTrail,
  unclosedSessionTrails, type SessionTrailHost, type SessionTrailPageWatch,
} from "./session-trail-record";

const PREFIX = "haptic:session-trail:";
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A browser the test drives: its storage, clock, renewal timer and page events. */
function fakeHost(startAt: number) {
  const items = new Map<string, string>();
  let now = startAt;
  let renew: (() => void) | null = null;
  let page: SessionTrailPageWatch | null = null;
  let full = false;
  const host: SessionTrailHost = {
    storage: {
      get length() { return items.size; },
      key: (index) => [...items.keys()][index] ?? null,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        if (full) throw new DOMException("full", "QuotaExceededError");
        items.set(key, value);
      },
      removeItem: (key) => { items.delete(key); },
    },
    now: () => now,
    setInterval: (callback) => { renew = callback; return 1; },
    clearInterval: () => { renew = null; },
    watchPage: (watch) => { page = watch; return () => { page = null; }; },
    newPageId: () => "this-page",
  };
  return {
    host, items,
    /** Storage refuses every write while full. */
    fill: (isFull: boolean) => { full = isFull; },
    /** Lets `ms` pass, renewing the record as a running page does. */
    run(ms: number) {
      for (let passed = SESSION_TRAIL_ALIVE_MS; passed <= ms; passed += SESSION_TRAIL_ALIVE_MS) {
        now = startAt + passed;
        renew?.();
      }
      now = startAt + ms;
      startAt = now;
    },
    /** The page's main thread does not run for `ms`; then the one renewal that was due runs, late. */
    hang(ms: number) {
      now = startAt + ms;
      startAt = now;
      renew?.();
    },
    hide: () => page!.visible(false),
    show: () => page!.visible(true),
    close: (detail = "pagehide, persisted false") => page!.closed(detail),
    unload: () => page!.unloading(),
    /** Another page's record: last renewed `agoMs` before now, with `stages` marked a second apart before that. */
    otherPage(id: string, agoMs: number, stages: string[], events?: SessionTrailEvent[]) {
      const alive = now - agoMs;
      const marks: SessionTrailMark[] = stages.map((stage, index) => ({ at: alive - (stages.length - 1 - index) * 1_000, stage }));
      items.set(PREFIX + id, JSON.stringify({ alive, marks, ...(events ? { events } : {}) }));
    },
    record: (id = "this-page") => JSON.parse(items.get(PREFIX + id)!) as { alive: number; marks: SessionTrailMark[]; events: SessionTrailEvent[] },
  };
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  resetSessionTrail();
});

describe("a page's stored session trail", () => {
  it("holds every mark as it is made, and is renewed while the page runs", () => {
    const browser = fakeHost(1_000_000);
    stop = startSessionTrail(browser.host);
    markSessionTrail("play: preparing");
    expect(browser.record().marks.map((mark) => mark.stage)).toEqual(["app: started", "play: preparing"]);
    expect(browser.record().alive).toBe(1_000_000);
    browser.run(12_000);
    // Renewed at 5 s and 10 s.
    expect(browser.record().alive).toBe(1_010_000);
  });

  it("ends with the page's being hidden or closed, and goes on when the page shows again", () => {
    const browser = fakeHost(1_000_000);
    stop = startSessionTrail(browser.host);
    browser.hide();
    expect(browser.record().marks.at(-1)!.stage).toBe(SESSION_TRAIL_HIDDEN);
    browser.show();
    expect(browser.record().marks.at(-1)!.stage).toBe("page: visible");
    browser.close();
    expect(browser.record().marks.at(-1)!.stage).toBe(SESSION_TRAIL_CLOSED);
  });
});

describe("the trails of pages that stopped without closing", () => {
  it("are those no longer renewed whose last mark is neither hidden nor closed, oldest first", () => {
    const browser = fakeHost(1_000_000);
    browser.otherPage("froze-later", 20_000, ["app: started", "play: running"]);
    browser.otherPage("froze-first", 60_000, ["app: started", "play: stopping", "play: disposing"]);
    // Another tab that is running: its record was renewed 5 s ago.
    browser.otherPage("running", 5_000, ["app: started", "play: running"]);
    stop = startSessionTrail(browser.host);
    markSessionTrail("play: preparing");
    const unclosed = unclosedSessionTrails();
    expect(unclosed.map((trail) => trail.page)).toEqual(["froze-first", "froze-later"]);
    expect(unclosed[0]).toEqual({
      page: "froze-first", alive: 940_000,
      marks: [{ at: 938_000, stage: "app: started" }, { at: 939_000, stage: "play: stopping" }, { at: 940_000, stage: "play: disposing" }],
      events: [],
    });
  });

  it("keep only the marks this build can read from a record another build wrote", () => {
    const browser = fakeHost(1_000_000);
    const event = { at: 939_200, first: 939_000, kind: "uncaught error", detail: "TypeError: a is null", count: 2 };
    browser.items.set(PREFIX + "older", JSON.stringify({
      alive: 940_000, marks: [{ at: 939_000, stage: "play: stopping" }, { at: 939_500 }, null, { stage: "x" }], events: [event, { at: 1 }, null],
    }));
    stop = startSessionTrail(browser.host);
    expect(unclosedSessionTrails()).toEqual([{ page: "older", alive: 940_000, marks: [{ at: 939_000, stage: "play: stopping" }], events: [event] }]);
  });

  it("include a page once it has missed three renewals", () => {
    const browser = fakeHost(1_000_000);
    browser.otherPage("other", 5_000, ["app: started", "play: running"]);
    stop = startSessionTrail(browser.host);
    expect(unclosedSessionTrails()).toEqual([]);
    browser.run(9_999);
    expect(unclosedSessionTrails()).toEqual([]);
    browser.run(1);
    expect(unclosedSessionTrails().map((trail) => trail.page)).toEqual(["other"]);
  });

  it("stay until a report has told them, while pages that ended in the ordinary way are removed at the next start", () => {
    const browser = fakeHost(1_000_000);
    browser.otherPage("froze", 60_000, ["app: started", "play: stopping"]);
    browser.otherPage("closed", 60_000, ["app: started", SESSION_TRAIL_CLOSED]);
    browser.otherPage("put-away", 60_000, ["app: started", SESSION_TRAIL_HIDDEN]);
    // A hidden tab renewed a moment ago may come back: its record stays.
    browser.otherPage("hidden-now", 2_000, ["app: started", SESSION_TRAIL_HIDDEN]);
    stop = startSessionTrail(browser.host);
    expect([...browser.items.keys()].sort()).toEqual([PREFIX + "froze", PREFIX + "hidden-now", PREFIX + "this-page"]);
    forgetSessionTrails(["froze"]);
    expect(unclosedSessionTrails()).toEqual([]);
    expect(browser.items.has(PREFIX + "froze")).toBe(false);
  });

  it("are dropped unreported after two weeks", () => {
    const browser = fakeHost(100 * DAY_MS);
    browser.otherPage("recent", 13 * DAY_MS, ["app: started", "play: running"]);
    browser.otherPage("old", 14 * DAY_MS, ["app: started", "play: running"]);
    stop = startSessionTrail(browser.host);
    expect(unclosedSessionTrails().map((trail) => trail.page)).toEqual(["recent"]);
    expect(browser.items.has(PREFIX + "old")).toBe(false);
  });

  it("are none before the page keeps a trail of its own", () => {
    expect(unclosedSessionTrails()).toEqual([]);
    expect(sessionTrailPage()).toBeNull();
  });

  it("include a page that closed after a stop of the editor's own once stale, and a named page at once whatever its end", () => {
    const reload: SessionTrailEvent = { at: 999_000, first: 999_000, kind: "reload", detail: "a failed chunk import", count: 1 };
    const error: SessionTrailEvent = { at: 999_000, first: 999_000, kind: "uncaught error", detail: "TypeError: a is null", count: 1 };
    const browser = fakeHost(1_000_000);
    browser.otherPage("reloaded", 1_000, ["check: heavy baseline 17", SESSION_TRAIL_CLOSED], [reload]);
    browser.otherPage("errored-then-closed", 1_000, ["app: started", SESSION_TRAIL_CLOSED], [error]);
    browser.otherPage("check-page", 1_000, ["check: heavy baseline 19", SESSION_TRAIL_CLOSED]);
    stop = startSessionTrail(browser.host);
    expect(unclosedSessionTrails().map((trail) => trail.page)).toEqual([]);
    expect(unclosedSessionTrails("check-page").map((trail) => trail.page)).toEqual(["check-page"]);
    browser.run(SESSION_TRAIL_STALE_MS);
    // A plain error before an ordinary close is no stop of the editor's own.
    expect(unclosedSessionTrails().map((trail) => trail.page)).toEqual(["reloaded"]);
    // Kept across the next start, which removes ordinary ends.
    stop();
    resetSessionTrail();
    stop = startSessionTrail(browser.host);
    expect([...browser.items.keys()].filter((key) => key !== PREFIX + "this-page")).toEqual([PREFIX + "reloaded"]);
  });
});

describe("a page's stored trail around an unfinished check and full storage", () => {
  it("keeps the page an unfinished check names at the next start, whatever it ended with", () => {
    const browser = fakeHost(1_000_000);
    browser.otherPage("check-page", 60_000, ["check: heavy baseline 17", SESSION_TRAIL_CLOSED]);
    browser.otherPage("closed", 60_000, ["app: started", SESSION_TRAIL_CLOSED]);
    stop = startSessionTrail(browser.host, () => "check-page");
    expect(browser.items.has(PREFIX + "check-page")).toBe(true);
    expect(browser.items.has(PREFIX + "closed")).toBe(false);
  });

  it("says how many writes failed once one gets through", () => {
    const browser = fakeHost(1_000_000);
    stop = startSessionTrail(browser.host);
    browser.fill(true);
    markSessionTrail("check: heavy baseline 17");
    markSessionTrail("check: heavy baseline 18");
    browser.fill(false);
    markSessionTrail("check: heavy baseline 19");
    expect(browser.record()).toMatchObject({ failedWrites: 2 });
    expect(browser.record().marks.at(-1)!.stage).toBe("check: heavy baseline 19");
  });
});

describe("a page's recorded events", () => {
  it("are stored with the marks as they happen, the page's close with its detail last before the closed mark", () => {
    const browser = fakeHost(1_000_000);
    stop = startSessionTrail(browser.host);
    recordSessionTrailEvent("uncaught error", "TypeError: a is null");
    expect(browser.record().events.map((event) => `${event.kind}: ${event.detail}`)).toEqual(["uncaught error: TypeError: a is null"]);
    browser.hide();
    browser.show();
    browser.unload();
    browser.close("pagehide, persisted false");
    expect(browser.record().events.map((event) => `${event.kind}: ${event.detail}`)).toEqual([
      "uncaught error: TypeError: a is null",
      "page: hidden",
      "page: unloading (beforeunload: a reload or navigation)",
      "page: closed (pagehide, persisted false)",
    ]);
    expect(browser.record().marks.at(-1)!.stage).toBe(SESSION_TRAIL_CLOSED);
  });

  it("include a renewal that came late while the page was visible, but not one of a hidden page", () => {
    const browser = fakeHost(1_000_000);
    stop = startSessionTrail(browser.host);
    browser.run(SESSION_TRAIL_ALIVE_MS * 3);
    expect(browser.record().events).toEqual([]);
    browser.hang(12_000);
    expect(browser.record().events.map((event) => `${event.kind}: ${event.detail}`)).toEqual(["stall: the page did not run for 12 s"]);
    browser.hide();
    browser.hang(60_000);
    expect(browser.record().events.filter((event) => event.kind === "stall")).toHaveLength(1);
  });
});
