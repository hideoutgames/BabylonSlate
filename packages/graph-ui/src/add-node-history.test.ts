import { describe, expect, it } from "vitest";
import {
  AddNodeHistory,
  HALF_LIFE_DAYS,
  MAX_CONTEXTS,
  MAX_PICKS_PER_CONTEXT,
  type AddNodeHistoryBackend,
  type AddNodeHistoryRecord,
} from "./add-node-history";

const DAY_MS = 86_400_000;

function fakeBackend(initial: unknown[] = []) {
  const saved = new Map<string, AddNodeHistoryRecord>(
    initial.map((record) => [(record as AddNodeHistoryRecord).key, record as AddNodeHistoryRecord]),
  );
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = false;
  const backend: AddNodeHistoryBackend = {
    loadAll: async () => {
      if (gated) await gate;
      return [...saved.values()] as AddNodeHistoryRecord[];
    },
    write: async (put, remove) => {
      for (const record of put) saved.set(record.key, structuredClone(record));
      for (const key of remove) saved.delete(key);
    },
    clear: async () => saved.clear(),
  };
  return {
    backend,
    saved,
    holdLoad: () => {
      gated = true;
      return release;
    },
  };
}

function clock(day = 20_000) {
  const time = { now: day * DAY_MS };
  return { time, now: () => time.now };
}

const nodes = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: Array<{ id: string }>) => list.map((node) => node.id);

describe("AddNodeHistory", () => {
  it("keeps the default order until a node is picked twice", () => {
    const history = new AddNodeHistory(fakeBackend().backend, clock().now);
    const ordered = nodes("branch", "print", "delay");
    expect(ids(history.rank("pin", ordered))).toEqual(["branch", "print", "delay"]);
    history.record("pin", "delay");
    expect(ids(history.rank("pin", ordered))).toEqual(["branch", "print", "delay"]);
    history.record("pin", "delay");
    expect(ids(history.rank("pin", ordered))).toEqual(["delay", "branch", "print"]);
    expect(ids(history.rank("other-pin", ordered))).toEqual(["branch", "print", "delay"]);
  });

  it("orders promoted nodes by score, keeps the default order for ties, and caps the promoted rows", () => {
    const history = new AddNodeHistory(fakeBackend().backend, clock().now);
    const ordered = nodes("a", "b", "c", "d", "e", "f", "g", "h");
    for (const id of ["h", "g", "f", "e", "d", "c"]) {
      history.record("pin", id);
      history.record("pin", id);
    }
    history.record("pin", "h");
    expect(ids(history.rank("pin", ordered))).toEqual(["h", "c", "d", "e", "f", "a", "b", "g"]);
  });

  it("only promotes nodes that are still offered", () => {
    const history = new AddNodeHistory(fakeBackend().backend, clock().now);
    history.record("pin", "removed");
    history.record("pin", "removed");
    expect(ids(history.rank("pin", nodes("a", "b")))).toEqual(["a", "b"]);
  });

  it("lets old picks fade below the promotion threshold", () => {
    const { time, now } = clock();
    const history = new AddNodeHistory(fakeBackend().backend, now);
    history.record("pin", "delay");
    history.record("pin", "delay");
    time.now += HALF_LIFE_DAYS * DAY_MS;
    expect(ids(history.rank("pin", nodes("print", "delay")))).toEqual(["print", "delay"]);
    history.record("pin", "delay");
    expect(ids(history.rank("pin", nodes("print", "delay")))).toEqual(["delay", "print"]);
  });

  it("keeps only the strongest picks per context", async () => {
    const { backend, saved } = fakeBackend();
    const history = new AddNodeHistory(backend, clock().now);
    history.record("pin", "favourite");
    for (let index = 0; index < MAX_PICKS_PER_CONTEXT; index++) {
      history.record("pin", "favourite");
      history.record("pin", `node-${index}`);
    }
    await history.flush();
    const picks = Object.keys(saved.get("pin")!.picks);
    expect(picks).toHaveLength(MAX_PICKS_PER_CONTEXT);
    expect(picks).toContain("favourite");
    expect(picks).toContain(`node-${MAX_PICKS_PER_CONTEXT - 1}`);
    expect(picks).not.toContain("node-0");
  });

  it("evicts the least recently used context beyond the limit", async () => {
    const { backend, saved } = fakeBackend();
    const history = new AddNodeHistory(backend, clock().now);
    for (let index = 0; index <= MAX_CONTEXTS; index++) history.record(`pin-${index}`, "a");
    history.record("pin-0", "a");
    history.record(`pin-${MAX_CONTEXTS + 1}`, "a");
    await history.flush();
    expect(saved.size).toBe(MAX_CONTEXTS);
    expect(saved.has("pin-0")).toBe(true);
    expect(saved.has("pin-1")).toBe(false);
    expect(saved.has("pin-2")).toBe(false);
  });

  it("restores saved picks, skips unreadable records, and keeps picks made while loading", async () => {
    const day = 20_000;
    const { backend, holdLoad } = fakeBackend([
      { key: "pin", day, picks: { delay: [2, day] } },
      { key: "late", day, picks: { print: [5, day] } },
      { key: "broken", day, picks: { print: "many" } },
      "not a record",
    ]);
    const release = holdLoad();
    const history = new AddNodeHistory(backend, clock(day).now);
    const loading = history.load();
    history.record("late", "branch");
    history.record("late", "branch");
    release();
    await loading;
    expect(ids(history.rank("pin", nodes("print", "delay")))).toEqual(["delay", "print"]);
    expect(ids(history.rank("late", nodes("print", "branch")))).toEqual(["branch", "print"]);
    expect(ids(history.rank("broken", nodes("x", "print")))).toEqual(["x", "print"]);
  });

  it("clears memory and saved history, ignoring a load that finishes afterwards", async () => {
    const day = 20_000;
    const { backend, saved, holdLoad } = fakeBackend([
      { key: "pin", day, picks: { delay: [3, day] } },
    ]);
    const release = holdLoad();
    const history = new AddNodeHistory(backend, clock(day).now);
    const loading = history.load();
    await history.clear();
    release();
    await loading;
    expect(history.isEmpty()).toBe(true);
    expect(saved.size).toBe(0);
    expect(ids(history.rank("pin", nodes("print", "delay")))).toEqual(["print", "delay"]);
  });
});
