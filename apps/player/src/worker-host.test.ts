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
  postMessage(message: BridgeHostMessage) {
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
