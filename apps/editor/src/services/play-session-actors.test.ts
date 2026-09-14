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
  // Actor tests drive ticks explicitly; browser paint is covered by the host tests.
  waitForSceneLoadingPaint: () => Promise.resolve(),
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
        presentFirstFrame?: () => Promise<void>;
        onFatalDiagnostic?: () => void;
      } = {},
    ): Promise<RuntimeDriver> {
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal("requestAnimationFrame", () => 1);
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.mocked(createEngine).mockReturnValue({
        applySceneEnvironment() {},
        scheduler: { invalidate() {}, acquireObstruction: () => () => {} },
        liveObjectCounts: () => ({ meshes: 0, textures: 0 }),
        applyCommand() {},
        pushSnapshot() {},
        whenEditorModelsReady: () => Promise.resolve(),
        whenMaterialTexturesReady: () => Promise.resolve(),
        prewarmSceneMaterials: () => Promise.resolve(),
        presentFirstFrame: options.presentFirstFrame ?? (() => Promise.resolve()),
        dispose() {},
      } as unknown as ReturnType<typeof createEngine>);

      let runtime!: RuntimeDriver;
      let finishBoot!: () => void;
      let failBoot!: (error: unknown) => void;
      const booted = new Promise<void>((resolve, reject) => {
        finishBoot = resolve;
        failBoot = reject;
      });
      vi.mocked(createRuntimeFromLoad).mockImplementation((load, onCommand) => {
        runtime = createInProcessRuntime({
          ...runtimeOptionsFromLoadControl(load),
          onCommand,
          preferSoftwarePhysics: true,
        });
        const finishLoading = runtime.finishPlayLoading.bind(runtime);
        vi.spyOn(runtime, "finishPlayLoading").mockImplementation(() => {
          finishLoading();
          finishBoot();
        });
        const reportError = runtime.reportError.bind(runtime);
        vi.spyOn(runtime, "reportError").mockImplementation((...args) => {
          const diagnostic = reportError(...args);
          failBoot(args[0]);
          return diagnostic;
        });
        return runtime;
      });
      if (mode === "in-process") {
        vi.mocked(createGameWorkerHost).mockImplementation(() => {
          throw new Error("Worker unavailable");
        });
      } else {
        const boot = createPlayBootCoordinator();
        let onCommand: (command: CommandMessage) => void = () => {};
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
            if (control.type === "play") void boot.play(runtime).catch(failBoot);
            if (control.type === "sceneLoadingPainted")
              runtime.notifySceneLoadingPainted(control.sceneAssetGuid, control.sceneLoadId);
            if (control.type === "sceneModelsReady")
              runtime.notifySceneModelsReady(control.sceneAssetGuid, control.sceneLoadId);
            if (control.type === "stop") {
              boot.reset();
              runtime.stop();
            }
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
        onFatalDiagnostic: options.onFatalDiagnostic,
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

    it("keeps Game Instance ticking and withholds scene finish until the renderer presents", async () => {
      let present!: () => void;
      const presentFirstFrame = vi.fn(() => new Promise<void>((resolve) => { present = resolve; }));
      const runtime = await play({
        gameInstanceClass: "LoadingGame",
        presentFirstFrame,
        scripts: [{
          assetGuid: "loading-game", classId: "LoadingGame", parentClassId: "GameInstance",
          source: [
            "export function onTick(ctx) { ctx.setVariable('ticked', true); }",
            "export function onSceneFinishLoading(ctx) { ctx.setVariable('finished', true); }",
          ].join("\n"),
          anchors: [],
          entryPoints: [
            { name: "onTick", event: "onTick", isAsync: false },
            { name: "onSceneFinishLoading", event: "onSceneFinishLoading", isAsync: false },
          ],
        }],
      });
      await vi.waitFor(() => expect(presentFirstFrame).toHaveBeenCalledOnce());
      runtime.tick();
      expect(runtime.getWorld().gameInstance?.getVariable("ticked")).toBe(true);
      expect(runtime.getWorld().gameInstance?.getVariable("finished")).not.toBe(true);
      present();
      await vi.waitFor(() => expect(runtime.getWorld().gameInstance?.getVariable("finished")).toBe(true));
    });

    it("retains first-frame failure diagnostics after the Play overlay closes", async () => {
      let rejectPresentation!: (error: Error) => void;
      const presentFirstFrame = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPresentation = reject; }));
      let stopped: ReturnType<PlaySession["stop"]> | undefined;
      const onFatalDiagnostic = vi.fn(() => {
        stopped = session!.stop();
        session = undefined;
      });
      await play({ presentFirstFrame, onFatalDiagnostic });
      await vi.waitFor(() => expect(presentFirstFrame).toHaveBeenCalledOnce());
      const failure = new Error("First frame shader pipeline unavailable");
      rejectPresentation(failure);
      await vi.waitFor(() => expect(onFatalDiagnostic).toHaveBeenCalledOnce());
      expect(stopped?.diagnostics).toEqual([expect.objectContaining({
        code: "scene.loading.failed", assetGuid: "scene", severity: "error",
        message: "Scene loading failed: First frame shader pipeline unavailable", stack: failure.stack,
      })]);
    });

    it("keeps a placed main actor at its authored position and runs Begin Play", async () => {
      const actor = createActor("placed-main", "Main", { classId: "main" });
      actor.transform.position = [4, 5, 6];
      const runtime = await play({ actors: [actor] });
      const actors = runtime.getWorld().getActors();
      expect(actors).toHaveLength(1);
      expect(actors[0]!.guid).toBe("placed-main");
      expect(actors[0]!.transform.position).toEqual({ x: 4, y: 5, z: 6 });
      // Authored Begin Play follows the renderer's completed first-frame ACK.
      await vi.waitFor(() => expect(actors[0]!.getVariable("began")).toBe(true));
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
      // Authored Begin Play follows the renderer's completed first-frame ACK.
      await vi.waitFor(() => expect(actors[0]!.getVariable("began")).toBe(true));
    });
  },
);
