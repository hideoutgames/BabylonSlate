import type { ScriptBundleEntry } from "@babylonslate/bridge";
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
  assetGuid?: string;
  graphId?: string;
  nodeId?: string;
  btNodeId?: string;
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

  const handle: EngineHandle = createEngine(canvas, {
    playMode: true,
    maxActors: 256,
    frameCap: manifest.playFrameCap,
    textureBytes: game.textureBytes,
    modelBytes: game.modelBytes,
    environmentColor: scene.settings.environmentColor,
    ktx2BasePath: ktx2BasePath(),
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
  }

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
    includeDebugCommands: manifest.bundleDebugger,
  };

  const spawn = spawnListForScripts(game.scripts);
  let ticks = 0;
  let worker: PlayerWorkerHost | null = null;
  let runtime: RuntimeDriver | null = null;
  const diagnostics: PlayerDiagnostic[] = [];

  const onCommand = (command: { type: string } & Record<string, unknown>) => {
    if (command.type === "assignMesh") {
      handle.applyCommand(command as never);
    }
    if (command.type === "possessCamera" || command.type === "setShadowQuality") {
      handle.applyCommand(command as never);
    }
    if (command.type === "animState") {
      handle.applyCommand(command as never);
    }
    if (command.type === "stats") {
      ticks = Number(command.tickIndex ?? ticks + 1);
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
        assetGuid: command.assetGuid as string | undefined,
        graphId: command.graphId as string | undefined,
        nodeId: command.nodeId as string | undefined,
        btNodeId: command.btNodeId as string | undefined,
      });
      options.onDiagnostic?.(diagnostics);
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
    worker.postControl({ type: "play" });
  } catch {
    worker = null;
    runtime = createRuntimeFromLoad(loadControl, (command) =>
      onCommand(command as never),
    );
    const boot = createPlayBootCoordinator();
    if (game.scripts.length > 0) {
      boot.queueScripts(runtime, game.scripts, spawn);
    }
    void boot.play(runtime);
  }

  return {
    ticks: () => ticks,
    stop: () => {
      worker?.terminate();
      runtime?.stop();
      handle.dispose();
      return { diagnostics };
    },
  };
}
