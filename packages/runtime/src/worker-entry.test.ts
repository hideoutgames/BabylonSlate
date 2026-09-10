import { afterEach, expect, it, vi } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import type { BridgeHostMessage, ControlMessage } from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import {
  createRuntimeFromLoad,
  runtimeOptionsFromLoadControl,
} from "./play-load";

vi.mock("./play-load", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./play-load")>()),
  createRuntimeFromLoad: vi.fn(),
}));

let send: ((control: ControlMessage) => void) | undefined;
afterEach(() => {
  send?.({ type: "stop" });
  send = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loading scripts without a spawn list does not create unplaced actors in the game worker", async () => {
  const host = {
    onmessage: undefined as
      ((event: { data: BridgeHostMessage }) => void) | undefined,
    performance,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
  };
  vi.stubGlobal("self", host);
  vi.stubGlobal("postMessage", () => {});
  let runtime!: RuntimeDriver;
  let finishBoot!: () => void;
  const booted = new Promise<void>((resolve) => {
    finishBoot = resolve;
  });
  vi.mocked(createRuntimeFromLoad).mockImplementation((load, onCommand) => {
    runtime = createInProcessRuntime({
      ...runtimeOptionsFromLoadControl(load),
      onCommand,
      preferSoftwarePhysics: true,
    });
    const resume = runtime.resume.bind(runtime);
    vi.spyOn(runtime, "resume").mockImplementation(() => {
      resume();
      finishBoot();
    });
    return runtime;
  });
  await import("./worker-entry");
  send = (payload) =>
    host.onmessage!({ data: { channel: "control", payload } });
  send({
    type: "load",
    sceneAssetGuid: "empty",
    scene: { ...createDefaultScene(), actors: [] },
  });
  send({
    type: "loadScripts",
    scripts: [
      {
        assetGuid: "main-class",
        classId: "main",
        parentClassId: "Actor",
        source: "export function onBeginPlay() {}",
        anchors: [],
        entryPoints: [
          { name: "onBeginPlay", event: "onBeginPlay", isAsync: false },
        ],
      },
    ],
  });
  send({ type: "play" });
  await booted;
  runtime.tick();
  expect(runtime.getWorld().getActors()).toHaveLength(0);
});
