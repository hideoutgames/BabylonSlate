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
  attachInputCapture: () => ({ dispose() {}, setSuppressed() {}, neutralize() {} }),
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
        scenes?: Parameters<typeof startPlaySession>[0]["scenes"];
        prepareSceneStream?: () => Promise<void>;
        applyCommand?: (command: CommandMessage) => void;
        captureFrame?: () => Promise<unknown>;
        onGameTimePaused?: (paused: boolean) => void;
        acquireAssetSources?: Parameters<typeof startPlaySession>[0]["acquireAssetSources"];
        acquireSceneSources?: (sources: unknown, options: { prepare?: boolean; priority?: string }) => Promise<() => void>;
        onSceneStreamingPaused?: (paused: boolean) => void;
      } = {},
    ): Promise<RuntimeDriver> {
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal("requestAnimationFrame", () => 1);
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.mocked(createEngine).mockReturnValue({
        applySceneEnvironment() {},
        engine: { isWebGPU: false },
        scalabilityStatus: () => null,
        captureFrame: options.captureFrame,
        cancelFrameCapture() {},
        setGameTimePaused: options.onGameTimePaused ?? (() => {}),
        scheduler: { invalidate() {}, acquireObstruction: () => () => {}, gateState: () => ({ frameCap: 60 }) },
        liveObjectCounts: () => ({ meshes: 0, textures: 0 }),
        applyCommand: options.applyCommand ?? (() => {}),
        pushSnapshot() {},
        renderPathStatus: () => ({
          requested: { renderPath: "forward", gpuBackend: "webgl2" },
          effective: { renderPath: "forward", gpuBackend: "webgl2" },
          limits: [],
        }),
        whenEditorModelsReady: () => Promise.resolve(),
        whenMaterialTexturesReady: () => Promise.resolve(),
        prewarmSceneMaterials: () => Promise.resolve(),
        presentFirstFrame: options.presentFirstFrame ?? (() => Promise.resolve()),
        prepareSceneStream: options.prepareSceneStream ?? (() => Promise.resolve()),
        acquireSceneSources: options.acquireSceneSources ?? (async () => () => {}),
        releaseInitialSources() {},
        setSourceLibraries() {},
        setCommandSourceLoader() {},
        setSceneStreamingPaused: options.onSceneStreamingPaused ?? (() => {}),
        dispose() {},
        whenReleased: () => Promise.resolve(),
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
            if (control.type === "sceneStreamReady") runtime.notifySceneStreamReady(control.actorGuid, control.streamLoadId);
            if (control.type === "sceneStreamProgress") runtime.notifySceneStreamProgress(control.actorGuid, control.streamLoadId, control.progress);
            if (control.type === "sceneStreamFailed") runtime.notifySceneStreamFailed(control.actorGuid, control.streamLoadId, control.message);
            if (control.type === "assetPreloadResult") runtime.notifyAssetPreloadResult(control);
            if (control.type === "assetLoadStates") runtime.setAssetLoadStates(control.states);
            if (control.type === "sessionBoundary") void runtime.requestSessionBoundary(control).then(result => onCommand({ type: "sessionBoundaryResult", ...result }));
            if (control.type === "diagnosticOperation") void runtime.requestDiagnosticOperation(control).then(result => onCommand({ type: "diagnosticOperationResult", ...result }));
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
        scenes: options.scenes,
        scripts: [mainScript, ...(options.scripts ?? [])],
        gameInstanceClass: options.gameInstanceClass,
        onFatalDiagnostic: options.onFatalDiagnostic,
        acquireAssetSources: options.acquireAssetSources,
      });
      await booted;
      runtime.tick();
      return runtime;
    }

    it("captures after an acknowledged normal Play pause without clearing another hold or ticking", async () => {
      let renderPaused = false;
      const captureFrame = vi.fn(async () => {
        expect(renderPaused).toBe(true);
        return { coherent: true };
      });
      const runtime = await play({ captureFrame, onGameTimePaused: paused => { renderPaused = paused; } });
      const before = runtime.getWorld().clock.tickIndex;
      session!.setPaused(true);
      await expect(session!.diagnostics!.captureFrame()).resolves.toEqual({ coherent: true });
      expect(runtime.getWorld().clock.tickIndex).toBe(before);
      await session!.setPauseReason("lifecycle", true);
      const resumeUser = await session!.setPauseReason("user", false);
      expect(resumeUser).toMatchObject({ paused: true, pauseReasons: ["lifecycle"] });
      runtime.advance(1 / 30);
      expect(runtime.getWorld().clock.tickIndex).toBe(before);
      expect(captureFrame).toHaveBeenCalledTimes(1);
      await session!.setPauseReason("lifecycle", false);
      expect(renderPaused).toBe(false);
    });

    it("does not create the default model actor when its class is merely loaded", async () => {
      const runtime = await play();
      expect(runtime.getWorld().getActors()).toHaveLength(0);
      expect(session!.spawnedActorGuids()).toEqual([]);
    });

    it("delivers capture lens edits and explicit capture requests to the renderer", async () => {
      const applyCommand = vi.fn();
      await play({
        actors: [createActor("capture", "Capture", { classId: "Monitor", components: [
          { id: "lens", classId: "RenderTargetCaptureComponent", properties: { renderTargetGuid: "screen", captureEveryFrame: false } },
        ] })],
        scripts: [{
          assetGuid: "monitor", classId: "Monitor", parentClassId: "RenderTargetCapture",
          anchors: [], entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
          source: `export function onBeginPlay(ctx) {
            ctx.setRenderTargetCaptureProperty(ctx.self, "fieldOfView", 45);
            ctx.captureRenderTarget(ctx.self);
          }`,
        }],
        applyCommand,
      });
      await vi.waitFor(() => {
        expect(applyCommand).toHaveBeenCalledWith(expect.objectContaining({
          type: "configureRenderTargetCapture", actorGuid: "capture",
          settings: expect.objectContaining({ renderTargetGuid: "screen", captureEveryFrame: false, fieldOfView: 45 }),
        }));
        expect(applyCommand).toHaveBeenCalledWith({ type: "captureRenderTarget", actorGuid: "capture" });
      });
    });

    it("keeps stream readiness isolated while the host pauses and resumes a blocking graph load", async () => {
      let finish!: () => void;
      const prepare = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const applyCommand = vi.fn();
      const runtime = await play({ actors: [createActor("streamer", "Streamer", { classId: "SceneStreamingActor", components: [
        { id: "stream", classId: "SceneStreamingComponent", properties: { sceneGuid: "child", sceneName: "Child" } },
      ] })], scenes: [{ guid: "child", scene: { ...createDefaultScene(), actors: [createActor("child", "Child", { classId: "main" })] } }],
      prepareSceneStream: prepare, applyCommand });
      const target = runtime.getWorld().findActor("streamer")!;
      const loading = runtime.loadSceneStream(target, true);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      const loadingCommand = applyCommand.mock.calls.map(([command]) => command as CommandMessage).find((command) => command.type === "sceneStreamLoading");
      expect(loadingCommand).toEqual({ type: "sceneStreamLoading", actorGuid: "streamer", streamLoadId: expect.any(Number) });
      const before = runtime.getWorld().clock.tickIndex;
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(before);
      expect(runtime.getSceneState(target)).toBe("Loading");
      finish();
      await loading;
      expect(runtime.getSceneState(target)).toBe("Loaded");
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(before + 1);
      await runtime.unloadSceneStream(target);
      expect(applyCommand).toHaveBeenCalledWith({ ...loadingCommand, type: "sceneStreamRemoved" });
      expect(runtime.getWorld().getActors().map((actor) => actor.guid)).toEqual(["streamer"]);
    });

    const loaderScript = (source: string): ScriptBundleEntry => ({
      assetGuid: "loader", classId: "Loader", parentClassId: "Actor", anchors: [], source,
      entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: source.includes("await") }],
    });

    it.each([["Low", "background"], ["Normal", "preload"], ["High", "gameplay"]] as const)(
      "schedules a script's %s priority asset load as %s in source and renderer preparation",
      async (priority, scheduled) => {
        const acquireAssetSources = vi.fn(async () => ({ sources: {} as never, release() {} }));
        const acquireSceneSources = vi.fn(async () => () => {});
        await play({
          actors: [createActor("loader", "Loader", { classId: "Loader" })],
          scripts: [loaderScript(`export function onBeginPlay(ctx) { ctx.requestAssetLoad(["cold"], { priority: "${priority}" }); }`)],
          acquireAssetSources, acquireSceneSources,
        });
        await vi.waitFor(() => expect(acquireAssetSources).toHaveBeenCalledOnce());
        expect(acquireAssetSources).toHaveBeenCalledWith(["cold"], expect.objectContaining({ consumer: "loader", priority: scheduled }));
        await vi.waitFor(() => expect(acquireSceneSources).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prepare: true, priority: scheduled })));
      },
    );

    it("pauses render game time while a blocking asset load holds the simulation", async () => {
      let finish!: () => void;
      const acquireAssetSources = vi.fn(() => new Promise<{ sources: never; release(): void }>((resolve) => {
        finish = () => resolve({ sources: {} as never, release() {} });
      }));
      const onSceneStreamingPaused = vi.fn();
      const runtime = await play({
        actors: [createActor("loader", "Loader", { classId: "Loader" })],
        scripts: [loaderScript('export async function onBeginPlay(ctx) { await ctx.waitForAssetLoad(ctx.requestAssetLoad(["cold"]), { blocking: true }); ctx.setVariable("done", true); }')],
        acquireAssetSources, onSceneStreamingPaused,
      });
      await vi.waitFor(() => expect(onSceneStreamingPaused).toHaveBeenCalledWith(true));
      const before = runtime.getWorld().clock.tickIndex;
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(before);
      finish();
      await vi.waitFor(() => expect(onSceneStreamingPaused).toHaveBeenLastCalledWith(false));
      await vi.waitFor(() => expect(runtime.getWorld().findActor("loader")!.getVariable("done")).toBe(true));
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
