/**
 * Game worker entry. Hosts create a Worker from this module URL and post
 * control / input messages. In-process Play uses `createInProcessRuntime`.
 */
import {
  type BridgeHostMessage,
  type ControlMessage,
} from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";

let runtime: RuntimeDriver | null = null;

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
    case "loadScripts": {
      const spawn = msg.spawn ?? msg.scripts.map((s) => ({ classId: s.classId }));
      void rt
        .loadScripts(msg.scripts)
        .then(() => {
          for (const entry of spawn) rt.spawnScriptedActor(entry);
        })
        .catch((error) => rt.reportError(error));
      break;
    }
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
  const buf = new Float32Array(16 + 256 * 16);
  if (rt.copySnapshot(buf)) {
    postMessage(
      { channel: "snapshot", payload: buf.buffer, transferable: true },
      [buf.buffer],
    );
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
  }
};

self.addEventListener("error", (event) => {
  ensureRuntime().reportError(event.error ?? event.message);
});

self.addEventListener("unhandledrejection", (event) => {
  ensureRuntime().reportError(event.reason);
});
