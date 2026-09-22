import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_HEARTBEAT_MS,
  SESSION_LIVENESS_KEY,
  startSessionLiveness,
  UNCLEAN_EXIT_WINDOW_MS,
} from "./session-liveness";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => JSON.parse(map.get(SESSION_LIVENESS_KEY) ?? "null"),
    write: (v: string) => map.set(SESSION_LIVENESS_KEY, v),
  };
}

function fakeTarget() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    listeners,
    addEventListener: (type: string, fn: EventListener) =>
      listeners.get(type)?.add(fn) ?? listeners.set(type, new Set([fn])),
    removeEventListener: (type: string, fn: EventListener) =>
      listeners.get(type)?.delete(fn),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn({} as Event)),
  };
}

describe("session liveness", () => {
  let now: number;
  let storage: ReturnType<typeof memoryStorage>;
  let target: ReturnType<typeof fakeTarget>;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    storage = memoryStorage();
    target = fakeTarget();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const start = () =>
    startSessionLiveness({ storage, target, now: () => now });

  it("records a live session on first start without an unclean exit", () => {
    const session = start();
    expect(session.uncleanExit).toBeNull();
    expect(storage.read()).toMatchObject({ alive: true, exits: [] });
  });

  it("does not flag a clean pagehide restart", () => {
    const first = start();
    target.fire("pagehide");
    first.stop();
    const second = start();
    expect(second.uncleanExit).toBeNull();
  });

  it("flags a restart that never saw pagehide", () => {
    const first = start();
    first.setProject({ guid: "g1", name: "Orbit" });
    const lastSeen = storage.read().lastSeen;
    now += 60_000;
    const second = start();
    expect(second.uncleanExit).toEqual({
      project: { guid: "g1", name: "Orbit" },
      lastSeenAt: lastSeen,
      recentCount: 1,
    });
  });

  it("counts repeated unclean exits", () => {
    start();
    now += 1000;
    start();
    now += 1000;
    start();
    now += 1000;
    const fourth = start();
    expect(fourth.uncleanExit?.recentCount).toBe(3);
  });

  it("prunes exits older than the window", () => {
    start();
    now += UNCLEAN_EXIT_WINDOW_MS + 1;
    const second = start();
    expect(second.uncleanExit?.recentCount).toBe(1);
    now += UNCLEAN_EXIT_WINDOW_MS + 1;
    const third = start();
    expect(third.uncleanExit?.recentCount).toBe(1);
  });

  it("recovers from a corrupt record", () => {
    storage.write("{not json");
    const session = start();
    expect(session.uncleanExit).toBeNull();
    expect(storage.read()).toMatchObject({ v: 1, alive: true, exits: [] });
  });

  it("advances lastSeen on the heartbeat", () => {
    start();
    const before = storage.read().lastSeen;
    now += SESSION_HEARTBEAT_MS + 1;
    vi.advanceTimersByTime(SESSION_HEARTBEAT_MS);
    expect(storage.read().lastSeen).toBe(now);
    expect(storage.read().lastSeen).toBeGreaterThan(before);
  });

  it("restores alive after pagehide then pageshow", () => {
    start();
    target.fire("pagehide");
    expect(storage.read().alive).toBe(false);
    target.fire("pageshow");
    expect(storage.read().alive).toBe(true);
  });

  it("never throws when storage writes fail", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const session = startSessionLiveness({ storage: throwing, target });
    expect(() => session.setProject({ guid: "g", name: "P" })).not.toThrow();
    session.stop();
  });

  it("stop removes listeners and clears the heartbeat", () => {
    const session = start();
    session.stop();
    expect(target.listeners.get("pagehide")?.size ?? 0).toBe(0);
    expect(target.listeners.get("pageshow")?.size ?? 0).toBe(0);
    const lastSeen = storage.read().lastSeen;
    now += SESSION_HEARTBEAT_MS * 3;
    vi.advanceTimersByTime(SESSION_HEARTBEAT_MS * 3);
    expect(storage.read().lastSeen).toBe(lastSeen);
  });
});
