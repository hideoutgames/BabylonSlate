/**
 * Game worker entry. Hosts create a Worker from this module URL and post
 * control / input messages. In-process Play uses `createInProcessRuntime`.
 */
import {
  TransferablePingPong,
  type BridgeHostMessage,
  type ControlMessage,
} from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";

let runtime: RuntimeDriver | null = null;
// Recycled via the host's `recycleSnapshot` message so the per-frame
// snapshot transfer never allocates a fresh ArrayBuffer once warmed up.
const snapshotPing = new TransferablePingPong(256);

function ensureRuntime(seed = 1): RuntimeDriver {
  if (!runtime) {
    runtime = createInProcessRuntime({
      seed,
      onCommand: (command) => {
        postMessage({ channel: "command", payload: command });
      },
    });
  }
  return runtime;
}

function handleControl(msg: ControlMessage): void {
  const rt = ensureRuntime();
  switch (msg.type) {
    case "load":
      rt.getWorld().loadScene(msg.sceneAssetGuid);
      break;
    case "play":
      rt.start();
      rt.resume();
      break;
    case "pause":
      rt.pause();
      break;
    case "step":
      rt.resume();
      rt.tick();
      rt.pause();
      break;
    case "stop":
      rt.stop();
      break;
    case "setPaused":
      if (msg.paused) rt.pause();
      else rt.resume();
      break;
  }
}

let lastTick = 0;
function pump(): void {
  const rt = runtime;
  if (!rt) return;
  const now = performance.now();
  if (lastTick === 0) lastTick = now;
  const elapsed = (now - lastTick) / 1000;
  lastTick = now;
  rt.advance(elapsed);
  const buf = snapshotPing.beginWrite();
  if (rt.copySnapshot(buf)) {
    const ab = snapshotPing.commitWrite();
    postMessage({ channel: "snapshot", payload: ab, transferable: true }, [
      ab,
    ]);
  } else {
    snapshotPing.cancelWrite();
  }
  requestAnimationFrame(pump);
}

self.onmessage = (event: MessageEvent<BridgeHostMessage>) => {
  const msg = event.data;
  if (msg.channel === "control") {
    handleControl(msg.payload);
    if (msg.payload.type === "play" && lastTick === 0) {
      requestAnimationFrame(pump);
    }
    return;
  }
  if (msg.channel === "input") {
    const rt = ensureRuntime();
    rt.pushInputBuffer(msg.payload as ArrayBuffer);
    return;
  }
  if (msg.channel === "recycleSnapshot") {
    snapshotPing.recycle(msg.payload);
  }
};

self.addEventListener("error", (event) => {
  ensureRuntime().reportError(event.error ?? event.message);
});

self.addEventListener("unhandledrejection", (event) => {
  ensureRuntime().reportError(event.reason);
});
