import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BridgeHostMessage, BridgeWorkerMessage, CommandMessage } from "@haptic/bridge";
import { createGameWorkerHost } from "./game-worker-host";

class FakeWorker {
  static instance: FakeWorker;
  static events: string[] = [];
  onmessage: ((event: MessageEvent<BridgeWorkerMessage>) => void) | null = null;
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
