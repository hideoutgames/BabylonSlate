import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeHostMessage, BridgeWorkerMessage, CommandMessage } from "@haptic/bridge";
import { createPlayerWorkerHost, prewarmPlayerWorker } from "./worker-host";

class FakeWorker {
  static instance: FakeWorker;
  static events: string[] = [];
  readonly messages: BridgeHostMessage[] = [];
  onmessage: ((event: MessageEvent<BridgeWorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminate = vi.fn();
  constructor() { FakeWorker.instance = this; }
  postMessage(message: BridgeHostMessage) {
    this.messages.push(message);
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
  FakeWorker.instance.onerror?.({ message: "", filename: "https://example.test/player/worker-worker-entry.js", lineno: 12, colno: 7 } as ErrorEvent);
  expect(errors).toEqual(["The game worker failed to start or stopped unexpectedly (https://example.test/player/worker-worker-entry.js:12:7)."]);
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

it("remembers a failure that came before anyone listened, and times a silent start from the first listener", () => {
  vi.useFakeTimers();
  try {
    const crashed = createPlayerWorkerHost();
    FakeWorker.instance.onerror?.({ message: "SyntaxError" } as ErrorEvent);
    expect(crashed.failed()).toBe(true);
    const slow = createPlayerWorkerHost();
    vi.advanceTimersByTime(9_000);
    const errors: string[] = [];
    slow.onError((error) => errors.push(error.message));
    vi.advanceTimersByTime(9_999);
    expect([errors, slow.failed()]).toEqual([[], false]);
    vi.advanceTimersByTime(1);
    expect(errors).toEqual(["The game worker did not start within 10 seconds: its module never finished loading."]);
  } finally { vi.useRealTimers(); }
});

describe("prewarmed player worker", () => {
  const controls = (worker: FakeWorker) => worker.messages.flatMap((message) => message.channel === "control" ? [message.payload] : []);

  it("loads the game's physics engine once per world and hands the same worker to the player", () => {
    const prewarmed = prewarmPlayerWorker(new AbortController().signal)!;
    const worker = FakeWorker.instance;
    prewarmed.preloadPhysics("3d");
    prewarmed.preloadPhysics("3d");
    expect(controls(worker)).toEqual([{ type: "preloadPhysics", physicsWorld: "3d", havokWasmUrl: new URL("./havok/HavokPhysics.wasm", document.baseURI).href }]);
    const host = prewarmed.take();
    expect(host).toBeDefined();
    expect(prewarmed.take()).toBeUndefined();
    // The player owns it now: a launch that ends does not stop it.
    prewarmed.release();
    expect(worker.terminate).not.toHaveBeenCalled();
    host!.postControl({ type: "play" });
    expect(controls(worker).map((control) => control.type)).toEqual(["preloadPhysics", "play"]);
  });

  it("terminates a worker the player never took when the launch ends or is aborted", () => {
    const ended = prewarmPlayerWorker(new AbortController().signal)!;
    const endedWorker = FakeWorker.instance;
    ended.release();
    expect(endedWorker.terminate).toHaveBeenCalledOnce();
    expect(ended.take()).toBeUndefined();
    const abort = new AbortController();
    const aborted = prewarmPlayerWorker(abort.signal)!;
    const abortedWorker = FakeWorker.instance;
    abort.abort();
    expect(abortedWorker.terminate).toHaveBeenCalledOnce();
    expect(aborted.take()).toBeUndefined();
  });

  it("never hands over a worker that failed while the game downloaded", () => {
    const prewarmed = prewarmPlayerWorker(new AbortController().signal)!;
    const worker = FakeWorker.instance;
    worker.onerror?.({ message: "Failed to fetch worker module" } as ErrorEvent);
    prewarmed.preloadPhysics("2d");
    expect(controls(worker)).toEqual([]);
    expect(prewarmed.take()).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("starts nothing when no worker can be created or the launch was already aborted", () => {
    expect(prewarmPlayerWorker(new AbortController().signal, () => { throw new Error("No module workers"); })).toBeUndefined();
    expect(prewarmPlayerWorker(AbortSignal.abort())).toBeUndefined();
  });
});
