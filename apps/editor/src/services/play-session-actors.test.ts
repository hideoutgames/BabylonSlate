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
import { startPlaySession, type PlaySceneSourceLoader, type PlaySession } from "./play-session";

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
const capture = vi.hoisted(() => ({ setSuppressed: vi.fn<(suppressed: boolean) => void>() }));
vi.mock("./input-capture", () => ({
  attachInputCapture: () => ({
    dispose() {}, setSuppressed: capture.setSuppressed, neutralize() {}, setTick() {}, pollGamepads() {}, ring: { drain: () => [] },
  }),
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
  capture.setSuppressed.mockReset();
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
        onSceneLoadFailed?: () => void;
        onSessionEnded?: () => void;
        onRuntimeLog?: (entry: { category: string; severity: string; message: string }) => void;
        scenes?: Parameters<typeof startPlaySession>[0]["scenes"];
        prepareSceneStream?: () => Promise<void>;
        applyCommand?: (command: CommandMessage) => void;
        pushSnapshot?: (buffer: Float32Array) => void;
        captureFrame?: () => Promise<unknown>;
        onGameTimePaused?: (paused: boolean) => void;
        acquireAssetSources?: Parameters<typeof startPlaySession>[0]["acquireAssetSources"];
        acquireSceneSources?: (sources: unknown, options: { prepare?: boolean; priority?: string }) => Promise<() => void>;
        onSceneStreamingPaused?: (paused: boolean) => void;
        /** Collects the host's animation-frame callbacks instead of dropping them. */
        frames?: FrameRequestCallback[];
        onRuntime?: (runtime: RuntimeDriver) => void;
        /** In-process mode: a worker that starts but cannot accept its boot controls. */
        failingWorkerTerminate?: () => void;
        /** Worker mode: observes the host terminating the worker. */
        workerTerminate?: () => void;
        /** Worker mode: deliver output as the worker would, including after Stop. */
        onWorker?: (worker: { command(command: CommandMessage): void; snapshot(buffer: Float32Array): void }) => void;
        /** In-process mode: prepares Scenes for scene changes. */
        sceneSources?: PlaySceneSourceLoader;
        audioReverbByScene?: ReadonlyMap<string, Uint8Array>;
        onAudioReverbField?: (field: Uint8Array | null) => void;
      } = {},
    ): Promise<RuntimeDriver> {
      vi.stubGlobal("window", new EventTarget());
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        options.frames?.push(callback);
        return 1;
      });
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.mocked(createEngine).mockReturnValue({
        applySceneEnvironment() {},
        engine: { isWebGPU: false },
        scalabilityStatus: () => null,
        captureFrame: options.captureFrame,
        cancelFrameCapture() {},
        setGameTimePaused: options.onGameTimePaused ?? (() => {}),
        scheduler: { invalidate() {}, acquireObstruction: () => () => {}, gateState: () => ({ frameCap: 60 }), stats: () => ({ renderedFps: 0 }) },
        liveObjectCounts: () => ({ meshes: 0, textures: 0 }),
        applyCommand: options.applyCommand ?? (() => {}),
        pushSnapshot: options.pushSnapshot ?? (() => {}),
        setGameInputEnabled() {},
        setSimulationEditMode() {},
        loadScene() {},
        resetAudioSession() {},
        resetParticleSession() {},
        setAudioReverbField: options.onAudioReverbField ?? (() => {}),
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
      vi.mocked(createRuntimeFromLoad).mockImplementation((load, onCommand, _storage, sourceHost) => {
        runtime = createInProcessRuntime({
          ...runtimeOptionsFromLoadControl(load),
          ...sourceHost,
          onCommand,
          preferSoftwarePhysics: true,
        });
        options.onRuntime?.(runtime);
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
      if (mode === "in-process" && options.failingWorkerTerminate) {
        vi.mocked(createGameWorkerHost).mockReturnValue({
          onCommand() {}, onSnapshot() {}, pushInput() {}, terminate: options.failingWorkerTerminate,
          postControl() { throw new DOMException("The load could not be cloned.", "DataCloneError"); },
        });
      } else if (mode === "in-process") {
        vi.mocked(createGameWorkerHost).mockImplementation(() => {
          throw new Error("Worker unavailable");
        });
      } else {
        const boot = createPlayBootCoordinator();
        let onCommand: (command: CommandMessage) => void = () => {};
        let onSnapshot: (buffer: Float32Array) => void = () => {};
        options.onWorker?.({ command: (command) => onCommand(command), snapshot: (buffer) => onSnapshot(buffer) });
        vi.mocked(createGameWorkerHost).mockReturnValue({
          onCommand: (handler) => {
            onCommand = handler;
          },
          onSnapshot: (handler) => {
            onSnapshot = handler;
          },
          pushInput() {},
          terminate: options.workerTerminate ?? (() => {}),
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
        onSceneLoadFailed: options.onSceneLoadFailed,
        onSessionEnded: options.onSessionEnded,
        onRuntimeLog: options.onRuntimeLog,
        acquireAssetSources: options.acquireAssetSources,
        acquireSceneSources: options.sceneSources,
        audioReverbByScene: options.audioReverbByScene,
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

    it("returns keyboard, pointer and gamepad input to the game after a Play pause", async () => {
      await play();
      await session!.setPauseReason("user", true);
      expect(capture.setSuppressed).toHaveBeenLastCalledWith(true);
      await session!.setPauseReason("user", false);
      expect(capture.setSuppressed).toHaveBeenLastCalledWith(false);
    });

    it("stops game time for a render hold without taking input from the game", async () => {
      const gameTime: boolean[] = [];
      await play({ onGameTimePaused: paused => gameTime.push(paused) });
      capture.setSuppressed.mockClear();
      gameTime.length = 0;
      const held = await session!.setPauseReason("rendering", true);
      expect(held).toMatchObject({ paused: true, pauseReasons: ["rendering"] });
      expect(capture.setSuppressed).not.toHaveBeenCalledWith(true);
      expect(gameTime).not.toContain(true);
      // Any other reason on top of the hold still takes input and stops the Engine's own game time.
      await session!.setPauseReason("user", true);
      expect(capture.setSuppressed).toHaveBeenLastCalledWith(true);
      expect(gameTime.at(-1)).toBe(true);
      await session!.setPauseReason("user", false);
      expect(capture.setSuppressed).toHaveBeenLastCalledWith(false);
      await session!.setPauseReason("rendering", false);
    });

    it("ends an editor input transition whose reset fails without holding game input", async () => {
      let refuseReset = false;
      await play({
        onRuntime: (runtime) => {
          const request = runtime.requestSessionBoundary.bind(runtime);
          vi.spyOn(runtime, "requestSessionBoundary").mockImplementation(async (boundary) => {
            const result = await request(boundary);
            return refuseReset && boundary.action.kind === "resetInput" ? { ...result, success: false, reason: "Reset refused" } : result;
          });
        },
      });
      await session!.setEditorInputSuppressed(true);
      expect(capture.setSuppressed).toHaveBeenLastCalledWith(true);
      refuseReset = true;
      await expect(session!.setEditorInputSuppressed(false)).rejects.toThrow("Reset refused");
      expect(capture.setSuppressed).toHaveBeenLastCalledWith(false);
    });

    it.runIf(mode === "worker")("does not present worker output that arrives after Stop", async () => {
      const applyCommand = vi.fn();
      const pushSnapshot = vi.fn();
      let worker!: { command(command: CommandMessage): void; snapshot(buffer: Float32Array): void };
      await play({ applyCommand, pushSnapshot, onWorker: (output) => { worker = output; } });
      session!.stop();
      session = undefined;
      applyCommand.mockClear();
      pushSnapshot.mockClear();
      worker.command({ type: "setFreeCam", enabled: true });
      worker.snapshot(new Float32Array(16));
      expect(applyCommand).not.toHaveBeenCalled();
      expect(pushSnapshot).not.toHaveBeenCalled();
    });

    it.runIf(mode === "worker")("keeps a stopped worker running End Play until it reports the stop finished", async () => {
      const terminate = vi.fn();
      let worker!: { command(command: CommandMessage): void; snapshot(buffer: Float32Array): void };
      await play({ workerTerminate: terminate, onWorker: (output) => { worker = output; } });
      const { released } = session!.stop();
      session = undefined;
      let settled = false;
      void released.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(terminate).not.toHaveBeenCalled();
      // The next session waits for release, so End Play saves cannot land in it.
      expect(settled).toBe(false);
      worker.command({ type: "runtimeStopped" });
      expect(terminate).toHaveBeenCalledOnce();
      await expect(released).resolves.toMatchObject({ quarantined: false });
      worker.command({ type: "runtimeStopped" });
      expect(terminate).toHaveBeenCalledOnce();
    });

    it.runIf(mode === "worker")("terminates a stopped worker that never reports the stop finished", async () => {
      const terminate = vi.fn();
      await play({ workerTerminate: terminate });
      vi.useFakeTimers();
      try {
        const { released } = session!.stop();
        session = undefined;
        let settled = false;
        void released.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(2999);
        expect(terminate).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(terminate).toHaveBeenCalledOnce();
        await expect(released).resolves.toMatchObject({ quarantined: false });
      } finally { vi.useRealTimers(); }
    });

    it.runIf(mode === "in-process")("applies each Scene's baked reverb on every later scene change", async () => {
      const reverbs: Record<string, Uint8Array> = { scene: new Uint8Array([1]), other: new Uint8Array([2]) };
      const fields: Array<Uint8Array | null> = [];
      const frames: FrameRequestCallback[] = [];
      const runtime = await play({
        frames,
        audioReverbByScene: new Map([["scene", reverbs.scene!]]),
        onAudioReverbField: (field) => fields.push(field),
        sceneSources: async (guid) => ({
          sources: {} as never, release() {}, scene: { ...createDefaultScene(), actors: [] }, audioReverb: reverbs[guid] ?? null,
        }),
      });
      const change = async (guid: string) => {
        let done = false;
        const work = runtime.changeSceneAsync(guid).finally(() => { done = true; });
        await vi.waitFor(() => {
          frames.shift()?.(performance.now());
          expect(done).toBe(true);
        }, { timeout: 4000 });
        await work;
      };
      await change("other");
      await change("scene");
      await change("other");
      expect(fields).toEqual([reverbs.other, reverbs.scene, reverbs.other]);
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

    it("tells the host a scene load failed and retains its diagnostics after the Play overlay closes", async () => {
      let rejectPresentation!: (error: Error) => void;
      const presentFirstFrame = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPresentation = reject; }));
      let stopped: ReturnType<PlaySession["stop"]> | undefined;
      const onFatalDiagnostic = vi.fn(() => {
        stopped = session!.stop();
        session = undefined;
      });
      // The failed load stays pending until the session stops, so the host learns of it here, not from progress.
      const onSceneLoadFailed = vi.fn();
      await play({ presentFirstFrame, onFatalDiagnostic, onSceneLoadFailed });
      await vi.waitFor(() => expect(presentFirstFrame).toHaveBeenCalledOnce());
      expect(onSceneLoadFailed).not.toHaveBeenCalled();
      const failure = new Error("First frame shader pipeline unavailable");
      rejectPresentation(failure);
      await vi.waitFor(() => expect(onFatalDiagnostic).toHaveBeenCalledOnce());
      expect(onSceneLoadFailed).toHaveBeenCalledOnce();
      expect(stopped?.diagnostics).toEqual([expect.objectContaining({
        code: "scene.loading.failed", assetGuid: "scene", severity: "error",
        message: "Scene loading failed: First frame shader pipeline unavailable", stack: failure.stack,
      })]);
    });

    it("hands a runtime quit to the host once, so the host can stop the session as its Stop control does", async () => {
      const onSessionEnded = vi.fn(() => {
        session!.stop();
        session = undefined;
      });
      const runtime = await play({ onSessionEnded });
      expect(runtime.executeConsoleCommand("quit")).toEqual({ success: true, output: "quit" });
      expect(onSessionEnded).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
    });

    it("feeds each Log node message to the host's Output Log once, with its category and severity", async () => {
      const onRuntimeLog = vi.fn();
      const logger: ScriptBundleEntry = {
        assetGuid: "logger-class", classId: "logger", parentClassId: "Actor",
        source: [
          "export function onBeginPlay(ctx) {",
          "  ctx.log('warning', 'Fuel', 'Low');",
          "  ctx.log('error', 'Fuel', 'Empty');",
          "}",
        ].join("\n"),
        anchors: [],
        entryPoints: [{ name: "onBeginPlay", event: "onBeginPlay", isAsync: false }],
      };
      await play({ actors: [createActor("pump", "Pump", { classId: "logger" })], scripts: [logger], onRuntimeLog });
      await vi.waitFor(() => expect(onRuntimeLog).toHaveBeenCalledTimes(2));
      // An error log also raises a runtime diagnostic; that one stays out of the Output Log feed.
      expect(onRuntimeLog.mock.calls.map(([entry]) => entry)).toEqual([
        { category: "Fuel", severity: "warning", message: "Low" },
        { category: "Fuel", severity: "error", message: "Empty" },
      ]);
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

    it.runIf(mode === "in-process")("terminates a worker that could not take its boot controls before falling back", async () => {
      const terminate = vi.fn();
      await play({ failingWorkerTerminate: terminate });
      expect(terminate).toHaveBeenCalledOnce();
    });

    it.runIf(mode === "in-process")("delivers a completed Scene with the next pumped snapshot when none was ready at realization", async () => {
      const frames: FrameRequestCallback[] = [];
      let refusedCopies = 0;
      let settled = false;
      const started = play({
        frames,
        onRuntime: (runtime) => {
          const copy = runtime.copySnapshot.bind(runtime);
          vi.spyOn(runtime, "copySnapshot").mockImplementation((out) => {
            if (refusedCopies === 0) {
              refusedCopies += 1;
              return false;
            }
            return copy(out);
          });
        },
      }).finally(() => { settled = true; });
      await vi.waitFor(() => expect(refusedCopies).toBe(1));
      await vi.waitFor(() => {
        frames.shift()?.(performance.now());
        expect(settled).toBe(true);
      }, { timeout: 4000 });
      await expect(started).resolves.toBeDefined();
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
