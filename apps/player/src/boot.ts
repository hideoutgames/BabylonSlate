import { snapshotFloatCount } from "@babylonslate/bridge";
import { encodeInputEvents } from "@babylonslate/input";
import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import {
  createPlayBootCoordinator,
  createRuntimeFromLoad,
  type RuntimeDriver,
} from "@babylonslate/runtime";
import {
  audioStats,
  createEngine,
  navDebugBlockersFromActors,
  particleStats,
  type EngineHandle,
} from "@babylonslate/render";
import { playFramebufferSize, type SerializedScene } from "@babylonslate/core";
import type { GameManifest } from "@babylonslate/exporter";
import { createPlayerWorkerHost, type PlayerWorkerHost } from "./worker-host";
import { createGameAudioSourceLoader, type LoadedGame } from "./artifact";
import { applyPlayerActiveScene, applyPlayerEngineCommand, schedulePlayerMaterialPrewarm, schedulePlayerSceneModelsReady } from "./engine-commands";
import { mountPlayerPrintOverlay } from "./print-overlay";
import { packedBootControls, packedContentFromGame } from "./hydrate";
import { attachInputCapture, playInputStampTick } from "./input";
import {
  applyPlayerFpsSample,
  applyPlayerSnapshotTick,
  applyWorkerPlayerStats,
  unlockAudioOnFirstGesture,
  type PlayerHudStats,
} from "./hud";
import { loopGuardLoadFields, shouldHaltPlayerOnDiagnostic } from "./debug-load";
import { playerSpawnListForScripts } from "./spawn-list";
import { packedFontCssStacks } from "./fonts";

function havokWasmUrl(): string {
  return new URL("./havok/HavokPhysics.wasm", document.baseURI).href;
}

function ktx2BasePath(): string {
  return new URL("./ktx2/", document.baseURI).href;
}

function dracoBasePath(): string {
  return new URL("./draco/", document.baseURI).href;
}

function meshoptBasePath(): string {
  return new URL("./meshopt/", document.baseURI).href;
}

export type PlayerDiagnostic = {
  message: string;
  severity: string;
  code?: string;
  assetGuid?: string;
  graphId?: string;
  nodeId?: string;
  btNodeId?: string;
  bodyLine?: number;
};

export type PlayerBootHandle = {
  ticks: () => number;
  visuals: () => ReturnType<EngineHandle["playVisualStates"]>;
  meshMaterialNames: () => string[];
  stop: () => { diagnostics: PlayerDiagnostic[] };
};

export function startPlayer(options: {
  canvas: HTMLCanvasElement;
  game: LoadedGame;
  onStats?: (stats: {
    ticks: number;
    fps: number;
    scriptMs: number;
    physicsMs: number;
    draws: number;
  }) => void;
  onDiagnostic?: (diagnostics: readonly PlayerDiagnostic[]) => void;
}): PlayerBootHandle {
  const { canvas, game } = options;
  const manifest: GameManifest = game.manifest;
  const startup = manifest.startupSceneGuid;
  const scene: SerializedScene | undefined = game.scenes.get(startup);
  if (!scene) {
    throw new Error("Set Startup Scene in Project Settings.");
  }
  const content = packedContentFromGame(game);
  const diagnostics: PlayerDiagnostic[] = [];
  const fontCss = packedFontCssStacks(game.fontFamilies);

  let worker: PlayerWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let input: ReturnType<typeof attachInputCapture> | null = null;

  const handle: EngineHandle = createEngine(canvas, {
    playMode: true,
    maxActors: 256,
    frameCap: manifest.playFrameCap,
    spritePayloads: content.spritePayloads,
    spriteAnimations: content.spriteAnimationPayloads,
    tilemapPayloads: content.tilemapPayloads,
    tilesetPayloads: content.tilesetPayloads,
    pixelsPerUnit: content.pixelsPerUnit,
    pixelPerfect: content.pixelPerfect,
    touchMinTargetPx: manifest.touchMinTargetPx ?? 44,
    textureBytes: game.textureBytes,
    texturePixelSizes: content.texturePixelSizes,
    fontFacetypeBytes: game.fontFacetypeBytes,
    fontMsdfJson: game.fontMsdfJson,
    fontMsdfPng: game.fontMsdfPng,
    fontCssStack: fontCss.fontCssStack,
    fontCssStackByGuid: fontCss.fontCssStackByGuid,
    modelBytes: game.modelBytes,
    modelPayloads: game.modelPayloads,
    modelClipAnimationGuids: content.modelClipAnimationGuids,
    retargetAnimationLoads: content.retargetAnimationLoads,
    audioBytes: game.audioBytes,
    loadAudioSourceBytes: createGameAudioSourceLoader(game),
    audioLibrary: content.audioLibrary,
    particleLibrary: content.particleLibrary,
    audioReverbBytes: content.audioReverbBytes,
    audioProjectSettings: {
      occlusionEnabled: manifest.occlusionEnabled !== false,
      reverbWetScale: manifest.reverbWetScale ?? 1,
      reverbDecayScale: manifest.reverbDecayScale ?? 1,
      reverbDampingScale: manifest.reverbDampingScale ?? 1,
    },
    materialDocuments: content.materialDocuments,
    materialFunctions: content.materialFunctions,
    postProcessStack: content.postProcessStack,
    environmentColor: scene.settings.environmentColor,
    viewportMode: scene.viewportMode,
    navmeshBytes: content.navmeshBytes,
    navBlockers: navDebugBlockersFromActors(scene.actors),
    ktx2BasePath: ktx2BasePath(),
    dracoBasePath: dracoBasePath(),
    meshoptBasePath: meshoptBasePath(),
    onPostProcessDiagnostic: (diagnostic) => {
      diagnostics.push({
        message: diagnostic.message,
        severity: "warning",
        assetGuid: diagnostic.materialGuid,
        nodeId: diagnostic.nodeId,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onAudioDiagnostic: (diagnostic) => {
      diagnostics.push({
        message: diagnostic.message,
        severity: "warning",
        code: diagnostic.code,
        assetGuid: diagnostic.assetGuid,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onParticleDiagnostic: (diagnostic) => {
      diagnostics.push({
        message: diagnostic.message,
        severity: "warning",
        code: diagnostic.code,
        assetGuid: diagnostic.assetGuid,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onMaterialDiagnostic: (diagnostic) => {
      diagnostics.push({
        message: diagnostic.message,
        severity: diagnostic.severity ?? "error",
        code: diagnostic.code,
        nodeId: diagnostic.nodeId,
      });
      options.onDiagnostic?.(diagnostics);
    },
    onSceneLayerPointer: (event) => {
      const control = { type: "sceneLayerPointer" as const, ...event };
      if (worker) worker.postControl(control);
      else runtime?.applySceneLayerPointer(control);
    },
    onSceneLayerResize: (size) => {
      const control = { type: "sceneLayerResize" as const, ...size };
      if (worker) worker.postControl(control);
      else
        runtime?.applySceneLayerResize(
          size.frustumWidth,
          size.frustumHeight,
          size.canvasWidth,
          size.canvasHeight,
        );
    },
    onAudioVoiceEnded: (voiceId) => {
      const control = { type: "audioVoiceEnded" as const, voiceId };
      if (worker) worker.postControl(control);
      else runtime?.applyAudioVoiceEnded(control);
    },
  });
  handle.applySceneEnvironment(scene);
  handle.scheduler.invalidate("play");
  const printHud = mountPlayerPrintOverlay(canvas.parentElement ?? canvas);
  if (typeof window !== "undefined") {
    (
      window as { __babylonslateAudioStats?: typeof audioStats }
    ).__babylonslateAudioStats = audioStats;
    (
      window as { __babylonslateParticleStats?: typeof particleStats }
    ).__babylonslateParticleStats = particleStats;
  }
  const framebuffer = playFramebufferSize(manifest.render);
  if (framebuffer) {
    handle.setSize(framebuffer.width, framebuffer.height);
  } else {
    handle.resize();
  }

  // Without a locked framebuffer the canvas is CSS-sized, so the backing store
  // has to follow the element or the first frames draw at the wrong size.
  const resizeObserver =
    framebuffer || typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
            handle.resize();
          }
        });
  resizeObserver?.observe(canvas);

  const scenes = [...game.scenes.entries()].map(([guid, authored]) => ({
    guid,
    scene: authored,
  }));
  const sceneLayers = [...game.sceneLayers.entries()].map(([guid, layer]) => ({
    guid,
    layer,
  }));
  const loadControl = {
    type: "load" as const,
    sceneAssetGuid: startup,
    scene,
    physicsWorld: manifest.physicsWorld,
    gravity: scene.settings.gravity,
    havokWasmUrl: havokWasmUrl(),
    gameInstanceClass:
      (typeof manifest.gameInstanceClass === "string" &&
      manifest.gameInstanceClass.trim()
        ? manifest.gameInstanceClass.trim()
        : undefined) ??
      scene.settings.gameInstanceClass ??
      undefined,
    scenes,
    sceneLayers,
    ...loopGuardLoadFields(manifest),
    audioAssetGuids: [...content.audioLibrary.audio.keys()],
    animClipCatalog: content.animClipCatalog,
    deferSceneModelsReady: true,
  };

  const spawn = playerSpawnListForScripts(game.scripts);
  let ticks = 0;
  let lastWorkerTickIndex = 0;
  let raf = 0;
  let halted = false;
  let hudStats: PlayerHudStats | undefined;

  const emitHudStats = (next: PlayerHudStats) => {
    hudStats = {
      ...next,
      draws: handle.drawCalls(),
      geometryBytes: handle.accountedGeometryBytes(),
    };
    options.onStats?.(hudStats);
  };

  const haltPlayback = () => {
    if (halted) return;
    halted = true;
    cancelAnimationFrame(raf);
    worker?.postControl({ type: "stop" });
    worker?.terminate();
    worker = null;
    runtime?.stop();
    printHud.dispose();
  };

  const materialsWarmed = { current: false };
  let hostSceneGuid: string | null = startup;
  const onCommand = (command: { type: string } & Record<string, unknown>) => {
    applyPlayerEngineCommand(handle, command);
    if (
      applyPlayerActiveScene(handle, game.scenes, command, hostSceneGuid) &&
      typeof command.sceneAssetGuid === "string"
    ) {
      hostSceneGuid = command.sceneAssetGuid;
    }
    schedulePlayerMaterialPrewarm(handle, command.type, materialsWarmed);
    if (command.type === "activeScene" && typeof command.sceneAssetGuid === "string") {
      schedulePlayerSceneModelsReady(
        (message) => {
          worker?.postControl(message);
          runtime?.notifySceneModelsReady(message.sceneAssetGuid);
        },
        handle,
        command.sceneAssetGuid,
      );
    }
    if (command.type === "print") {
      printHud.applyPrint({
        message: command.message,
        key: command.key,
        duration: command.duration,
        color: command.color,
      });
    }
    if (command.type === "stats") {
      emitHudStats(
        applyWorkerPlayerStats(hudStats, {
          ticks: lastWorkerTickIndex,
          fps: Number(command.fps ?? 0),
          scriptMs: Number(command.scriptMs ?? 0),
          physicsMs: Number(command.physicsMs ?? 0),
        }),
      );
    }
    if (command.type === "diagnostic") {
      diagnostics.push({
        message: String(command.message ?? ""),
        severity: String(command.severity ?? "error"),
        code: typeof command.code === "string" ? command.code : undefined,
        assetGuid: command.assetGuid as string | undefined,
        graphId: command.graphId as string | undefined,
        nodeId: command.nodeId as string | undefined,
        btNodeId: command.btNodeId as string | undefined,
        bodyLine:
          typeof command.bodyLine === "number" ? command.bodyLine : undefined,
      });
      options.onDiagnostic?.(diagnostics);
      if (shouldHaltPlayerOnDiagnostic(command.code)) {
        haltPlayback();
      }
    }
  };

  try {
    worker = createPlayerWorkerHost();
    worker.onCommand((cmd) => onCommand(cmd as never));
    worker.onSnapshot((buffer) => {
      lastWorkerTickIndex = applyPlayerSnapshotTick(lastWorkerTickIndex, buffer);
      ticks = lastWorkerTickIndex;
      handle.pushSnapshot(buffer);
    });
    worker.postControl(loadControl);
    for (const control of packedBootControls(content, game.scripts, spawn)) {
      worker.postControl(control);
    }
  } catch {
    worker = null;
    const inProcess = createRuntimeFromLoad(loadControl, (command) =>
      onCommand(command as never),
    );
    runtime = inProcess;
    const boot = createPlayBootCoordinator();
    if (game.scripts.length > 0) {
      boot.queueScripts(inProcess, game.scripts, spawn);
    }
    for (const entry of content.animGraphs) {
      const document = parseAnimGraphDocument(entry.document);
      if (document) inProcess.registerAnimGraph(entry.guid, document);
    }
    for (const entry of content.behaviourTrees) {
      const document = parseBehaviourTreeDocument(entry.document);
      if (document) inProcess.registerBehaviourTree(entry.guid, document);
    }
    for (const entry of content.blackboards) {
      const document = parseBlackboardDocument(entry.document);
      if (document) inProcess.registerBlackboard(entry.guid, document);
    }
    if (content.tilemapPayloads.size > 0 || content.tilesetPayloads.size > 0) {
      inProcess.registerTileContent({
        tilemaps: content.tilemapPayloads,
        tilesets: content.tilesetPayloads,
        pixelsPerUnit: content.pixelsPerUnit,
      });
    }
    if (
      content.spritePayloads.size > 0 ||
      content.spriteAnimationPayloads.size > 0
    ) {
      inProcess.registerSpriteContent({
        sprites: content.spritePayloads,
        spriteAnimations: content.spriteAnimationPayloads,
        pixelsPerUnit: content.pixelsPerUnit,
      });
    }
    if (content.modelPayloads.size > 0) {
      inProcess.registerModelContent({
        models: content.modelPayloads,
        complexMeshes: content.complexMeshes,
      });
    }
    if (content.navmeshBytes && content.navmeshBytes.byteLength > 0) {
      boot.queueNavMesh(inProcess, content.navmeshBytes);
    }
    void boot.play(inProcess).catch((error) => {
      inProcess.reportError(error);
    });
  }

  input = attachInputCapture(canvas, {
    skipPointerAndKeyboard: () => handle.isFreeCamEnabled(),
  });
  const releaseUnlock = unlockAudioOnFirstGesture(() => {
    void handle.unlockAudio();
  }, canvas);
  const snapBuf = new Float32Array(snapshotFloatCount(256));
  let last = performance.now();
  let frames = 0;
  let fpsWindowStart = last;

  const pump = () => {
    if (halted) return;
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    const tick = playInputStampTick(
      runtime?.getWorld().clock.tickIndex,
      lastWorkerTickIndex,
    );
    input?.setTick(tick);
    input?.pollGamepads();
    const drained = input?.ring.drain() ?? [];
    if (drained.length > 0) {
      if (worker) worker.pushInput(drained);
      else if (runtime) runtime.pushInputBuffer(encodeInputEvents(drained));
    }
    if (runtime) {
      runtime.advance(elapsed);
      if (runtime.copySnapshot(snapBuf)) {
        lastWorkerTickIndex = applyPlayerSnapshotTick(lastWorkerTickIndex, snapBuf);
        ticks = lastWorkerTickIndex;
        handle.pushSnapshot(snapBuf);
      }
    }
    frames += 1;
    if (now - fpsWindowStart >= 1000) {
      emitHudStats(applyPlayerFpsSample(hudStats, frames));
      frames = 0;
      fpsWindowStart = now;
    }
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  return {
    ticks: () => ticks,
    visuals: () => handle.playVisualStates(),
    meshMaterialNames: () => handle.playMeshMaterialNames(),
    stop: () => {
      halted = true;
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      input?.dispose();
      releaseUnlock();
      printHud.dispose();
      worker?.terminate();
      runtime?.stop();
      handle.dispose();
      return { diagnostics };
    },
  };
}
