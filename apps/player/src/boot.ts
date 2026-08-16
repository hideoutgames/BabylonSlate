import { snapshotFloatCount, type ScriptBundleEntry } from "@babylonslate/bridge";
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
import { createEngine, type EngineHandle } from "@babylonslate/render";
import type { SerializedScene } from "@babylonslate/core";
import type { GameManifest } from "@babylonslate/exporter";
import { createPlayerWorkerHost, type PlayerWorkerHost } from "./worker-host";
import type { LoadedGame } from "./artifact";
import { applyPlayerEngineCommand } from "./engine-commands";
import { packedContentFromGame, packedPlayControls } from "./hydrate";
import { attachInputCapture, playInputStampTick } from "./input";
import { loopGuardLoadFields, shouldHaltPlayerOnDiagnostic } from "./debug-load";

const ACTOR_LIFECYCLE_EVENTS = new Set(["onBeginPlay", "onTick"]);

function spawnListForScripts(
  scripts: readonly ScriptBundleEntry[],
): Array<{ classId: string }> {
  const seen = new Set<string>();
  const spawn: Array<{ classId: string }> = [];
  for (const script of scripts) {
    if (
      !script.entryPoints.some(
        (entry) => entry.event && ACTOR_LIFECYCLE_EVENTS.has(entry.event),
      )
    ) {
      continue;
    }
    if (seen.has(script.classId)) continue;
    seen.add(script.classId);
    spawn.push({ classId: script.classId });
  }
  return spawn;
}

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
    tilemapPayloads: content.tilemapPayloads,
    tilesetPayloads: content.tilesetPayloads,
    pixelsPerUnit: content.pixelsPerUnit,
    pixelPerfect: content.pixelPerfect,
    textureBytes: game.textureBytes,
    modelBytes: game.modelBytes,
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
  });
  handle.applySceneEnvironment(scene);
  handle.scheduler.invalidate("play");
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

  // Without a locked framebuffer the canvas is CSS-sized, so the backing store
  // has to follow the element or the first frames draw at the wrong size.
  const resizeObserver =
    framebuffer || typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (canvas.clientWidth > 0 && canvas.clientHeight > 0) handle.resize();
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
    gameInstanceClass: scene.settings.gameInstanceClass ?? undefined,
    scenes,
    ...loopGuardLoadFields(manifest),
  };

  const spawn = spawnListForScripts(game.scripts);
  let ticks = 0;
  let lastWorkerTickIndex = 0;
  let worker: PlayerWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  let raf = 0;
  let halted = false;

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
    if (command.type === "stats") {
      ticks = Number(command.tickIndex ?? ticks + 1);
      lastWorkerTickIndex = ticks;
      options.onStats?.({
        ticks,
        fps: Number(command.fps ?? 0),
        scriptMs: Number(command.scriptMs ?? 0),
        physicsMs: Number(command.physicsMs ?? 0),
        draws: handle.drawCalls(),
      });
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
    if (game.scripts.length > 0) {
      worker.postControl({
        type: "loadScripts",
        scripts: [...game.scripts],
        spawn,
      });
    }
    for (const control of packedPlayControls(content)) {
      worker.postControl(control);
    }
    worker.postControl({ type: "play" });
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
    if (content.navmeshBytes && content.navmeshBytes.byteLength > 0) {
      boot.queueNavMesh(inProcess, content.navmeshBytes);
    }
    void boot.play(inProcess).catch((error) => {
      inProcess.reportError(error);
    });
  }

  const input = attachInputCapture(canvas);
  const snapBuf = new Float32Array(snapshotFloatCount(256));
  let last = performance.now();

  const pump = () => {
    if (halted) return;
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    const tick = playInputStampTick(
      runtime?.getWorld().clock.tickIndex,
      lastWorkerTickIndex,
    );
    input.setTick(tick);
    input.pollGamepads();
    const drained = input.ring.drain();
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
    raf = requestAnimationFrame(pump);
  };
  raf = requestAnimationFrame(pump);

  return {
    ticks: () => ticks,
    stop: () => {
      halted = true;
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      input.dispose();
      worker?.terminate();
      runtime?.stop();
      handle.dispose();
      return { diagnostics };
    },
  };
}
