import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BridgeHostMessage, BridgeWorkerMessage, CommandMessage } from "@haptic/bridge";
import { createPlayerWorkerHost } from "./worker-host";

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

function observe(host: ReturnType<typeof createPlayerWorkerHost>) {
  host.onCommand((command) => FakeWorker.events.push(command.type === "log" ? command.message : command.type));
}

it("dispatches a commands batch in order exactly as the same commands sent one by one", () => {
  const sequence = [log("a"), layout, log("b")];
  observe(createPlayerWorkerHost());
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
  const host = createPlayerWorkerHost();
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
  expect(worker.posted[0]!.transfer).toBe(worker.posted[1]!.transfer);
});

it("hands the rest of a batch to nobody once a command's handler terminates the host", () => {
  const host = createPlayerWorkerHost();
  observe(host);
  host.onCommand((command) => { if (command.type === "log" && command.message === "a") host.terminate(); });
  FakeWorker.instance.receive({ channel: "commands", payload: [log("a"), log("b")] });
  expect(FakeWorker.events).toEqual(["a"]);
});

it("names where the worker failed when WebKit gives no message", () => {
  const host = createPlayerWorkerHost();
  const errors: string[] = [];
  host.onError((error) => errors.push(error.message));
  FakeWorker.instance.onerror?.({ message: "", filename: "https://example.test/player/worker-game-worker-entry.js", lineno: 12, colno: 7 } as ErrorEvent);
  expect(errors).toEqual(["The game worker failed to start or stopped unexpectedly (https://example.test/player/worker-game-worker-entry.js:12:7)."]);
});

it("reports a worker whose module never evaluates, and not one that started or was stopped", () => {
  vi.useFakeTimers();
  try {
    const errors: string[] = [];
    const silent = createPlayerWorkerHost();
    silent.onError((error) => errors.push(error.message));
    const started = createPlayerWorkerHost();
    started.onError((error) => errors.push(`started: ${error.message}`));
    FakeWorker.instance.receive({ channel: "ready" });
    const stopped = createPlayerWorkerHost();
    stopped.onError((error) => errors.push(`stopped: ${error.message}`));
    stopped.terminate();
    vi.advanceTimersByTime(10_000);
    expect(errors).toEqual(["The game worker did not start within 10 seconds: its module never finished loading."]);
  } finally { vi.useRealTimers(); }
});

it("remembers a failure no handler saw, and starts the start wait only once the boot attaches a handler", () => {
  vi.useFakeTimers();
  try {
    const crashed = createPlayerWorkerHost();
    FakeWorker.instance.onerror?.({ message: "Module failed to load" } as ErrorEvent);
    expect(crashed.failed()).toBe(true);

    // Prewarmed through a long download: the wait belongs to the boot that adopts it.
    const prewarmed = createPlayerWorkerHost();
    vi.advanceTimersByTime(30_000);
    expect(prewarmed.failed()).toBe(false);
    const errors: string[] = [];
    prewarmed.onError((error) => errors.push(error.message));
    vi.advanceTimersByTime(9_999);
    expect(errors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(errors).toEqual(["The game worker did not start within 10 seconds: its module never finished loading."]);
    expect(prewarmed.failed()).toBe(true);
  } finally { vi.useRealTimers(); }
});
