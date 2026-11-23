import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeHostMessage, BridgeWorkerMessage, CommandMessage } from "@haptic/bridge";
import { resetSessionTrail, sessionTrailEvents } from "@haptic/core";
import { createGameWorkerHost, preloadPrewarmedGameWorkerPhysics, prewarmGameWorker } from "./game-worker-host";

class FakeWorker {
  static instance: FakeWorker;
  static events: string[] = [];
  onmessage: ((event: MessageEvent<BridgeWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminate = vi.fn();
  constructor() { FakeWorker.instance = this; }
  posted: Array<{ message: BridgeHostMessage; transfer: Transferable[] }> = [];
  postMessage(message: BridgeHostMessage, transfer: Transferable[] = []) {
    this.posted.push({ message, transfer });
    if (message.channel === "snapshotLayoutAck") FakeWorker.events.push(`ack ${message.generation}`);
  }
  receive(message: BridgeWorkerMessage) {
    this.onmessage?.({ data: message } as MessageEvent<BridgeWorkerMessage>);
  }
}

const log = (message: string): CommandMessage => ({ type: "log", message, severity: "log", category: "console", frameId: 0 });
const layout: CommandMessage = { type: "snapshotLayout", capacity: 64, generation: 3 };

beforeEach(() => {
  FakeWorker.events = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

function observe(host: ReturnType<typeof createGameWorkerHost>) {
  host.onCommand((command) => FakeWorker.events.push(command.type === "log" ? command.message : command.type));
}

it("dispatches a commands batch in order exactly as the same commands sent one by one", () => {
  const sequence = [log("a"), layout, log("b")];
  observe(createGameWorkerHost());
  for (const payload of sequence) FakeWorker.instance.receive({ channel: "command", payload });
  const alone = FakeWorker.events.splice(0);

  FakeWorker.instance.receive({ channel: "commands", payload: sequence });
  // The layout is acknowledged before its handlers run, inside a batch too.
  expect(alone).toEqual(["a", "ack 3", "snapshotLayout", "b"]);
  expect(FakeWorker.events).toEqual(alone);
});

it("hands back each snapshot and sends each input in one reused envelope, moving that frame's own buffer", () => {
  // The break: an envelope and a transfer list made for every snapshot handed back and every input pushed, each frame.
  // A post clones and detaches before it returns, so the reuse is safe only if each post carries its own buffer.
  const host = createGameWorkerHost();
  const lengths: number[] = [];
  host.onSnapshot((buffer) => lengths.push(buffer.length));
  const worker = FakeWorker.instance;
  const carried: Array<{ channel: string; payload: unknown; moved: Transferable[] }> = [];
  const post = worker.postMessage.bind(worker);
  vi.spyOn(worker, "postMessage").mockImplementation((message, transfer = []) => {
    carried.push({ channel: message.channel, payload: "payload" in message ? message.payload : undefined, moved: [...transfer] });
    post(message, transfer);
  });
  worker.receive({ channel: "command", payload: layout });
  carried.length = 0;
  worker.posted.length = 0;
  const first = new ArrayBuffer(8);
  const second = new ArrayBuffer(16);
  // A pose of an older layout goes straight back too.
  const stale = new ArrayBuffer(4);
  worker.receive({ channel: "snapshot", payload: first, generation: 3 });
  worker.receive({ channel: "snapshot", payload: stale, generation: 2 });
  worker.receive({ channel: "snapshot", payload: second, generation: 3 });
  expect(lengths).toEqual([2, 4]);
  expect(carried.map((entry) => entry.channel)).toEqual(["recycleSnapshot", "recycleSnapshot", "recycleSnapshot"]);
  [first, stale, second].forEach((buffer, index) => {
    expect(carried[index]!.payload).toBe(buffer);
    expect(carried[index]!.moved).toHaveLength(1);
    expect(carried[index]!.moved[0]).toBe(buffer);
  });
  expect(new Set(worker.posted.map((entry) => entry.message)).size).toBe(1);
  expect(new Set(worker.posted.map((entry) => entry.transfer)).size).toBe(1);

  carried.length = 0;
  worker.posted.length = 0;
  host.pushInput([]);
  host.pushInput([]);
  expect(carried.map((entry) => entry.channel)).toEqual(["input", "input"]);
  expect(carried[0]!.payload).not.toBe(carried[1]!.payload);
  for (const entry of carried) {
    expect(entry.moved).toHaveLength(1);
    expect(entry.moved[0]).toBe(entry.payload);
  }
  expect(worker.posted[0]!.message).toBe(worker.posted[1]!.message);
});

it("hands the rest of a batch to nobody once a command's handler terminates the host", () => {
  const host = createGameWorkerHost();
  observe(host);
  host.onCommand((command) => { if (command.type === "log" && command.message === "a") host.terminate(); });
  FakeWorker.instance.receive({ channel: "commands", payload: [log("a"), log("b")] });
  expect(FakeWorker.events).toEqual(["a"]);
});

it("moves a navmesh buffer to the worker but still clones the load catalog the next session reuses", () => {
  const host = createGameWorkerHost();
  const startup = new Uint8Array([1, 2, 3]);
  const buffer = new Uint8Array([4, 5, 6]).buffer;
  host.postControl({ type: "load", sceneAssetGuid: "level", sceneNavmeshBytes: { level: startup } });
  host.postControl({ type: "loadNavMesh", bytes: buffer });
  host.postControl({ type: "loadNavMesh" });

  expect(FakeWorker.instance.posted.map(({ transfer }) => transfer)).toEqual([[], [buffer], []]);
});

it("reports a worker that fails to load or evaluate, with its location, instead of staying silent", () => {
  const host = createGameWorkerHost();
  const failures: string[] = [];
  host.onFailure((message) => failures.push(message));
  FakeWorker.instance.onerror?.({ message: "SyntaxError: Unexpected token", filename: "worker-entry.js", lineno: 3, colno: 7,
    preventDefault() {} } as unknown as ErrorEvent);
  expect(failures).toEqual(["The Play worker failed to start: SyntaxError: Unexpected token (worker-entry.js:3:7)"]);
});

it("reports a message the worker cannot deserialize", () => {
  const host = createGameWorkerHost();
  const failures: string[] = [];
  host.onFailure((message) => failures.push(message));
  FakeWorker.instance.onmessageerror?.({} as MessageEvent);
  expect(failures).toEqual(["The Play worker could not read a message from the game runtime."]);
});

it("reports a worker whose module never evaluates within the session boundary timeout, and only once", () => {
  vi.useFakeTimers();
  try {
    const host = createGameWorkerHost();
    const failures: string[] = [];
    host.onFailure((message) => failures.push(message));
    vi.advanceTimersByTime(9_999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failures).toEqual(["The Play worker did not start within 10 seconds: its module never finished loading."]);
    FakeWorker.instance.onerror?.({ message: "late", preventDefault() {} } as unknown as ErrorEvent);
    expect(failures).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it("does not report a worker that started, nor one the host terminated", () => {
  vi.useFakeTimers();
  try {
    const started = createGameWorkerHost();
    const failures: string[] = [];
    started.onFailure((message) => failures.push(message));
    FakeWorker.instance.receive({ channel: "ready" });
    const stopped = createGameWorkerHost();
    stopped.onFailure((message) => failures.push(message));
    stopped.terminate();
    vi.advanceTimersByTime(20_000);
    expect(failures).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it("leaves a started worker's uncaught errors to its own runtime diagnostics", () => {
  const host = createGameWorkerHost();
  const failures: string[] = [];
  host.onFailure((message) => failures.push(message));
  FakeWorker.instance.receive({ channel: "ready" });
  FakeWorker.instance.onerror?.({ message: "TypeError: x is undefined", preventDefault() {} } as unknown as ErrorEvent);
  expect(failures).toEqual([]);
  // It still reaches the session trail, for a report of a page that stops after it.
  expect(sessionTrailEvents().at(-1)).toMatchObject({ kind: "game worker", detail: "error after its start: TypeError: x is undefined" });
  resetSessionTrail();
});

describe("prewarmed session worker", () => {
  afterEach(() => {
    // Leave no prewarmed worker to the next test.
    createGameWorkerHost();
  });

  it("is the next session's worker, having loaded the Scene's physics engine before the session's boot content", () => {
    const ticket = new AbortController();
    prewarmGameWorker(ticket.signal);
    const prewarmed = FakeWorker.instance;
    preloadPrewarmedGameWorkerPhysics("3d", "https://editor.test/havok/HavokPhysics.wasm");
    preloadPrewarmedGameWorkerPhysics("3d", "https://editor.test/havok/HavokPhysics.wasm");
    const host = createGameWorkerHost();
    host.postControl({ type: "load", sceneAssetGuid: "level" });
    expect(FakeWorker.instance).toBe(prewarmed);
    expect(prewarmed.posted.map(({ message }) => message.channel === "control" ? message.payload.type : message.channel))
      .toEqual(["preloadPhysics", "load"]);
    // The session owns it now: its ticket ending later stops it through the session, not here.
    ticket.abort();
    expect(prewarmed.terminate).not.toHaveBeenCalled();
  });

  it("is terminated when its session ends before claiming it", () => {
    const ticket = new AbortController();
    prewarmGameWorker(ticket.signal);
    const prewarmed = FakeWorker.instance;
    ticket.abort();
    expect(prewarmed.terminate).toHaveBeenCalledOnce();
    createGameWorkerHost();
    expect(FakeWorker.instance).not.toBe(prewarmed);
  });

  it("is replaced by a new worker when it failed to start", () => {
    prewarmGameWorker(new AbortController().signal);
    const failed = FakeWorker.instance;
    failed.onerror?.({ message: "SyntaxError", preventDefault() {} } as unknown as ErrorEvent);
    const host = createGameWorkerHost();
    const failures: string[] = [];
    host.onFailure((message) => failures.push(message));
    expect(failed.terminate).toHaveBeenCalledOnce();
    expect(FakeWorker.instance).not.toBe(failed);
    expect(failures).toEqual([]);
  });
});

it("names the failure when the worker's script could not be fetched, which reports a bare error event", () => {
  const host = createGameWorkerHost();
  const failures: string[] = [];
  host.onFailure((message) => failures.push(message));
  FakeWorker.instance.onerror?.({ preventDefault() {} } as unknown as ErrorEvent);
  expect(failures).toEqual(["The Play worker failed to start: its module could not be loaded"]);
});
