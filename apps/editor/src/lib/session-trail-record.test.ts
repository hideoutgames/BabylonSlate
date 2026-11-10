import { afterEach, describe, expect, it } from "vitest";
import { markSessionTrail, resetSessionTrail, type SessionTrailMark } from "@haptic/core";
import {
  forgetSessionTrails, SESSION_TRAIL_ALIVE_MS, SESSION_TRAIL_CLOSED, SESSION_TRAIL_HIDDEN, startSessionTrail,
  unclosedSessionTrails, type SessionTrailHost,
} from "./session-trail-record";

const PREFIX = "haptic:session-trail:";
const DAY_MS = 24 * 60 * 60 * 1_000;

/** A browser the test drives: its storage, clock, renewal timer and page events. */
function fakeHost(startAt: number) {
  const items = new Map<string, string>();
  let now = startAt;
  let renew: (() => void) | null = null;
  let page: { closed: () => void; visible: (isVisible: boolean) => void } | null = null;
  const host: SessionTrailHost = {
    storage: {
      get length() { return items.size; },
      key: (index) => [...items.keys()][index] ?? null,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => { items.set(key, value); },
      removeItem: (key) => { items.delete(key); },
    },
    now: () => now,
    setInterval: (callback) => { renew = callback; return 1; },
    clearInterval: () => { renew = null; },
    watchPage: (closed, visible) => { page = { closed, visible }; return () => { page = null; }; },
    newPageId: () => "this-page",
  };
  return {
    host, items,
    /** Lets `ms` pass, renewing the record as a running page does. */
    run(ms: number) {
      for (let passed = SESSION_TRAIL_ALIVE_MS; passed <= ms; passed += SESSION_TRAIL_ALIVE_MS) {
        now = startAt + passed;
        renew?.();
      }
      now = startAt + ms;
      startAt = now;
    },
    hide: () => page!.visible(false),
    show: () => page!.visible(true),
    close: () => page!.closed(),
    /** Another page's record: last renewed `agoMs` before now, with `stages` marked a second apart before that. */
    otherPage(id: string, agoMs: number, stages: string[]) {
      const alive = now - agoMs;
      const marks: SessionTrailMark[] = stages.map((stage, index) => ({ at: alive - (stages.length - 1 - index) * 1_000, stage }));
      items.set(PREFIX + id, JSON.stringify({ alive, marks }));
    },
    record: (id = "this-page") => JSON.parse(items.get(PREFIX + id)!) as { alive: number; marks: SessionTrailMark[] },
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
    });
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
  });
});
