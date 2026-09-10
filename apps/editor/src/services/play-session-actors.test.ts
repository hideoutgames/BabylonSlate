import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import type { CommandMessage, ScriptBundleEntry } from "@babylonslate/bridge";
import {
  createInProcessRuntime,
  createPlayBootCoordinator,
  createRuntimeFromLoad,
  runtimeOptionsFromLoadControl,
  type RuntimeDriver,
} from "@babylonslate/runtime";
import { createEngine } from "@babylonslate/render";
import { createGameWorkerHost } from "./game-worker-host";
import { startPlaySession, type PlaySession } from "./play-session";

vi.mock("@babylonslate/render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/render")>()),
  createEngine: vi.fn(),
}));
vi.mock("@babylonslate/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/runtime")>()),
  createRuntimeFromLoad: vi.fn(),
}));
vi.mock("./game-worker-host", () => ({ createGameWorkerHost: vi.fn() }));
vi.mock("./input-capture", () => ({
  attachInputCapture: () => ({ dispose() {} }),
}));

const mainScript: ScriptBundleEntry = {
  assetGuid: "main-class",
  classId: "main",
  parentClassId: "Actor",
  source:
    "export function onBeginPlay(ctx) { ctx.setVariable('began', true); }",
  anchors: [],
  entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
  components: [
    { id: "model", classId: "MeshComponent", properties: { meshKind: "box" } },
  ],
};

let session: PlaySession | undefined;
afterEach(() => {
  session?.stop();
  session = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(["worker", "in-process"] as const)(
  "%s Play actor creation",
  (mode) => {
    async function play(
      options: {
        actors?: ReturnType<typeof createActor>[];
        scripts?: ScriptBundleEntry[];
        gameInstanceClass?: string;
      } = {},
    ): Promise<RuntimeDriver> {
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal("requestAnimationFrame", () => 1);
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.mocked(createEngine).mockReturnValue({
        applySceneEnvironment() {},
        scheduler: { invalidate() {} },
        liveObjectCounts: () => ({ meshes: 0, textures: 0 }),
        applyCommand() {},
        whenEditorModelsReady: () => Promise.resolve(),
        dispose() {},
      } as unknown as ReturnType<typeof createEngine>);

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
      if (mode === "in-process") {
        vi.mocked(createGameWorkerHost).mockImplementation(() => {
          throw new Error("Worker unavailable");
        });
      } else {
        const boot = createPlayBootCoordinator();
        let onCommand = (_command: CommandMessage) => {};
        vi.mocked(createGameWorkerHost).mockReturnValue({
          mode: "worker",
          onCommand: (handler) => {
            onCommand = handler;
          },
          onSnapshot() {},
          pushInput() {},
          terminate() {},
          postControl(control) {
            if (control.type === "load")
              runtime = createRuntimeFromLoad(control, onCommand);
            if (control.type === "loadScripts")
              boot.queueScripts(runtime, control.scripts, control.spawn ?? []);
            if (control.type === "play") void boot.play(runtime);
            if (control.type === "sceneModelsReady")
              runtime.notifySceneModelsReady(control.sceneAssetGuid);
            if (control.type === "stop") runtime.stop();
          },
        });
      }
      session = startPlaySession({
        canvas: new EventTarget() as HTMLCanvasElement,
        sharedEngine: {
          getLoadedTexturesCache: () => [],
        } as unknown as Parameters<typeof startPlaySession>[0]["sharedEngine"],
        sceneAssetGuid: "scene",
        scene: { ...createDefaultScene(), actors: options.actors ?? [] },
        scripts: [mainScript, ...(options.scripts ?? [])],
        gameInstanceClass: options.gameInstanceClass,
      });
      await booted;
      runtime.tick();
      return runtime;
    }

    it("does not create the default model actor when its class is merely loaded", async () => {
      const runtime = await play();
      expect(runtime.getWorld().getActors()).toHaveLength(0);
      expect(session!.spawnedActorGuids()).toEqual([]);
    });

    it("keeps a placed main actor at its authored position and runs Begin Play", async () => {
      const actor = createActor("placed-main", "Main", { classId: "main" });
      actor.transform.position = [4, 5, 6];
      const runtime = await play({ actors: [actor] });
      const actors = runtime.getWorld().getActors();
      expect(actors).toHaveLength(1);
      expect(actors[0]!.guid).toBe("placed-main");
      expect(actors[0]!.transform.position).toEqual({ x: 4, y: 5, z: 6 });
      expect(actors[0]!.getVariable("began")).toBe(true);
    });

    it("allows the GameInstance to explicitly SpawnActor without an extra default instance", async () => {
      const runtime = await play({
        gameInstanceClass: "SessionGame",
        scripts: [
          {
            assetGuid: "session-game",
            classId: "SessionGame",
            parentClassId: "GameInstance",
            source:
              "export function onInit(ctx) { ctx.spawnActor('main', { position: { x: 7, y: 8, z: 9 } }); }",
            anchors: [],
            entryPoints: [{ name: "onInit", event: "onInit", isAsync: false }],
          },
        ],
      });
      const actors = runtime.getWorld().getActors();
      expect(runtime.getWorld().gameInstance?.classId).toBe("SessionGame");
      expect(actors).toHaveLength(1);
      expect(actors[0]!.classId).toBe("main");
      expect(actors[0]!.transform.position).toEqual({ x: 7, y: 8, z: 9 });
      expect(actors[0]!.getVariable("began")).toBe(true);
    });
  },
);
