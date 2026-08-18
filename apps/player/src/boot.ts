import { snapshotFloatCount } from "@babylonslate/bridge";
import { encodeInputEvents } from "@babylonslate/input";
import { parseAnimGraphDocument } from "@babylonslate/anim-graph";
import {
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
} from "@babylonslate/behaviour-tree";
import {
  applyUiRuntimeControl,
  createPlayBootCoordinator,
  createRuntimeFromLoad,
  type RuntimeDriver,
} from "@babylonslate/runtime";
import { createEngine, audioStats, type EngineHandle } from "@babylonslate/render";
import type { SerializedScene } from "@babylonslate/core";
import type { GameManifest } from "@babylonslate/exporter";
import { createPlayerWorkerHost, type PlayerWorkerHost } from "./worker-host";
import { guiTextureBytesFromGame, type LoadedGame } from "./artifact";
import { applyPlayerActiveScene, applyPlayerEngineCommand } from "./engine-commands";
import {
  packedBootControls,
  packedContentFromGame,
  packedUserInterfaceControl,
} from "./hydrate";
import { attachInputCapture, playInputStampTick } from "./input";
import {
  applyPlayerFpsSample,
  applyWorkerPlayerStats,
  unlockAudioOnFirstGesture,
  type PlayerHudStats,
} from "./hud";
import { loopGuardLoadFields, shouldHaltPlayerOnDiagnostic } from "./debug-load";
import { packedFontEntries } from "./fonts";
import { applyPlayerUiCommand, createPlayerUiHost } from "./player-ui-host";
import { playerSpawnListForScripts } from "./spawn-list";

function havokWasmUrl(): string {
  return new URL("./havok/HavokPhysics.wasm", document.baseURI).href;
}

function ktx2BasePath(): string {
  return new URL("./ktx2/", document.baseURI).href;
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
    textureBytes: game.textureBytes,
    modelBytes: game.modelBytes,
    audioBytes: game.audioBytes,
    audioLibrary: content.audioLibrary,
    audioReverbBytes: content.audioReverbBytes,
    materialDocuments: content.materialDocuments,
    materialFunctions: content.materialFunctions,
    postProcessStack: content.postProcessStack,
    environmentColor: scene.settings.environmentColor,
    ktx2BasePath: ktx2BasePath(),
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
  });
  handle.applySceneEnvironment(scene);
  handle.scheduler.invalidate("play");
  if (typeof window !== "undefined") {
    (
      window as { __babylonslateAudioStats?: typeof audioStats }
    ).__babylonslateAudioStats = audioStats;
  }
  const framebuffer = manifest.render.customResolution
    ? {
        width: manifest.render.width,
        height: manifest.render.height,
      }
    : null;
  if (framebuffer) {
    handle.setSize(framebuffer.width, framebuffer.height);
  } else {
    handle.resize();
  }

  let worker: PlayerWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let input: ReturnType<typeof attachInputCapture> | null = null;
  const uiHost = createPlayerUiHost({
    scene: handle.scene,
    library: content.userInterfaces,
    textureBytes: guiTextureBytesFromGame(game),
    viewport: {
      width: Math.max(1, canvas.width || canvas.clientWidth || 1),
      height: Math.max(1, canvas.height || canvas.clientHeight || 1),
    },
    designerPresets: manifest.uiDesignerPresets,
    fontEntries: packedFontEntries({
      fontBytes: game.fontBytes,
      fontFamilies: game.fontFamilies,
    }),
    onWidgetEvent: (event) => {
      if (worker) worker.postControl(event);
      else if (runtime) applyUiRuntimeControl(runtime, event);
    },
    onTouchAxis: (controlId, value) => {
      input?.pushTouchAxis(controlId, value);
    },
  });

  // Without a locked framebuffer the canvas is CSS-sized, so the backing store
  // has to follow the element or the first frames draw at the wrong size.
  const resizeObserver =
    framebuffer || typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
            handle.resize();
            uiHost.resize(
              Math.max(1, canvas.width || canvas.clientWidth),
              Math.max(1, canvas.height || canvas.clientHeight),
            );
          }
        });
  resizeObserver?.observe(canvas);

  const scenes = [...game.scenes.entries()].map(([guid, authored]) => ({
    guid,
    scene: authored,
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
    ...loopGuardLoadFields(manifest),
    audioAssetGuids: [...content.audioLibrary.audio.keys()],
  };

  const spawn = playerSpawnListForScripts(game.scripts);
  let ticks = 0;
  let lastWorkerTickIndex = 0;
  let raf = 0;
  let halted = false;
  let hudStats: PlayerHudStats | undefined;

  const emitHudStats = (next: PlayerHudStats) => {
    hudStats = { ...next, draws: handle.drawCalls() };
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
  };

  const onCommand = (command: { type: string } & Record<string, unknown>) => {
    applyPlayerEngineCommand(handle, command);
    applyPlayerActiveScene(handle, game.scenes, command);
    applyPlayerUiCommand(uiHost, command);
    if (command.type === "stats") {
      ticks = Number(command.tickIndex ?? ticks + 1);
      lastWorkerTickIndex = ticks;
      emitHudStats(
        applyWorkerPlayerStats(hudStats, {
          ticks,
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
    worker.onSnapshot((buffer) => handle.pushSnapshot(buffer));
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
    const uiControl = packedUserInterfaceControl(content);
    if (uiControl) applyUiRuntimeControl(inProcess, uiControl);
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
    if (content.navmeshBytes && content.navmeshBytes.byteLength > 0) {
      boot.queueNavMesh(inProcess, content.navmeshBytes);
    }
    void boot.play(inProcess).catch((error) => {
      inProcess.reportError(error);
    });
  }

  input = attachInputCapture(canvas);
  const releaseUnlock = unlockAudioOnFirstGesture(() => {
    void handle.unlockAudio();
  });
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
    stop: () => {
      halted = true;
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      input?.dispose();
      releaseUnlock();
      uiHost.dispose();
      worker?.terminate();
      runtime?.stop();
      handle.dispose();
      return { diagnostics };
    },
  };
}
