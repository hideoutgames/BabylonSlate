import { afterEach, expect, it, vi } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import type { BridgeHostMessage, CommandMessage, ControlMessage } from "@babylonslate/bridge";
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

it("waits for the matching host paint before loading the authored world without unplaced script actors", async () => {
  const host = {
    onmessage: undefined as
      ((event: { data: BridgeHostMessage }) => void) | undefined,
    performance,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    addEventListener() {},
  };
  vi.stubGlobal("self", host);
  const commands: CommandMessage[] = [];
  vi.stubGlobal("postMessage", (message: { channel: string; payload: CommandMessage }) => {
    if (message.channel === "command") commands.push(message.payload);
  });
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
    const finish = runtime.finishPlayLoading.bind(runtime);
    vi.spyOn(runtime, "finishPlayLoading").mockImplementation(() => {
      finish();
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
    deferSceneLoadingPaint: true,
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
  await vi.waitFor(() => expect(commands.some((command) => command.type === "sceneLoading")).toBe(true));
  expect(commands.some((command) => command.type === "activeScene")).toBe(false);
  send({ type: "sceneLoadingPainted", sceneAssetGuid: "empty", sceneLoadId: 99 });
  await Promise.resolve();
  expect(commands.some((command) => command.type === "activeScene")).toBe(false);
  send({ type: "sceneLoadingPainted", sceneAssetGuid: "empty", sceneLoadId: 1 });
  await booted;
  expect(commands.some((command) => command.type === "activeScene")).toBe(true);
  runtime.tick();
  expect(runtime.getWorld().getActors()).toHaveLength(0);
});
