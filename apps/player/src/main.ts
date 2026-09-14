import type { GameManifest } from "@babylonslate/exporter";
import {
  getHostMemoryStats,
  type HostMemoryStats,
} from "@babylonslate/vfs";
import { loadGameFromFiles, loadGameFromHttp } from "./artifact";
import { startPlayerWithBackend } from "./player-backend";
import { mountPlayerHud, mountPlayerDebuggerOverlays } from "./hud";
import { applyPlayerLayout } from "./layout";
import { registerPackedFonts } from "./fonts";
import {
  PREVIEW_CONSOLE_REQUEST_MESSAGE,
  PREVIEW_CONSOLE_RESULT_MESSAGE,
  PREVIEW_CONSOLE_EVENT_MESSAGE,
  PREVIEW_CONSOLE_CATALOG_MESSAGE,
  PREVIEW_CONSOLE_CONTEXT_MESSAGE,
  isPreviewConsoleRequest,
} from "@babylonslate/exporter";
import {
  filesFromPreviewPack,
  isExpectedPreviewHostMessage,
  previewPackFromExpectedHostMessage,
  PREVIEW_DIAGNOSTICS_MESSAGE,
  PREVIEW_ERROR_MESSAGE,
  PREVIEW_READY_MESSAGE,
  PREVIEW_REQUEST_PACK_MESSAGE,
  PREVIEW_STATS_MESSAGE,
  PREVIEW_STOP_MESSAGE,
} from "./preview-protocol";

const previewHostOrigin = window.location.origin;
const startupAbort = new AbortController();
let stopCurrentPlayer: (() => void) | undefined;
// Install before pack loading, fonts or asynchronous backend initialization.
window.addEventListener("message", (event) => {
  if (!isExpectedPreviewHostMessage(event, window.parent, previewHostOrigin)) return;
  if (event.data?.type !== PREVIEW_STOP_MESSAGE) return;
  startupAbort.abort();
  try { stopCurrentPlayer?.(); }
  finally { rootEl().dataset.booted = "false"; }
});

function rootEl(): HTMLElement {
  return document.getElementById("player-root") ?? document.body;
}

function canvasEl(): HTMLCanvasElement {
  const canvas = document.getElementById("game");
  if (canvas instanceof HTMLCanvasElement) return canvas;
  throw new Error("Player canvas is missing");
}

function setRootState(options: {
  booted: boolean;
  ticks: number;
  startupScene: string;
}): void {
  const root = rootEl();
  root.dataset.booted = options.booted ? "true" : "false";
  root.dataset.ticks = String(options.ticks);
  root.dataset.startupScene = options.startupScene;
}

function layoutFromManifest(manifest: GameManifest): void {
  applyPlayerLayout({
    root: rootEl(),
    canvas: canvasEl(),
    render: manifest.render,
  });
}

async function launchFromFiles(files: Map<string, Uint8Array>): Promise<void> {
  const game = await loadGameFromFiles(files);
  await launchLoaded(game);
}

async function launchFromHttp(): Promise<void> {
  const game = await loadGameFromHttp(document.baseURI);
  await launchLoaded(game);
}

async function launchLoaded(
  game: Awaited<ReturnType<typeof loadGameFromFiles>>,
): Promise<void> {
  startupAbort.signal.throwIfAborted();
  await registerPackedFonts(game.fontBytes, undefined, game.fontFamilies);
  startupAbort.signal.throwIfAborted();
  const canvas = canvasEl();
  layoutFromManifest(game.manifest);
  const hud = mountPlayerHud(
    document.getElementById("player-hud") ?? document.createElement("div"),
    { bundleDebugger: game.manifest.bundleDebugger },
  );
  let currentLightsDebugText: string | null = null;
  const stopAudioOverlays = mountPlayerDebuggerOverlays(rootEl(), {
    lightsDebugText: () => currentLightsDebugText,
    bundleDebugger: game.manifest.bundleDebugger,
  });
  setRootState({
    booted: false,
    ticks: 0,
    startupScene: game.manifest.startupSceneGuid,
  });
  let hostMemory: HostMemoryStats | null = null;
  const refreshHostMemory = () => {
    void getHostMemoryStats()
      .then((stats) => {
        hostMemory = stats;
      })
      .catch(() => {
        hostMemory = null;
      });
  };
  refreshHostMemory();
  // Session-scoped HUD feed; cleared with the page, same as the render loop.
  const memoryInterval = window.setInterval(refreshHostMemory, 1000);

  const session = await startPlayerWithBackend({
    signal: startupAbort.signal,
    canvas,
    game,
    onConsoleEvent: (command) => {
      hud.applyCommand(command);
      if (window.parent === window || !previewMode()) return;
      if (
        [
          "log",
          "print",
          "diagnostic",
          "setBehaviourTreeDebug",
          "behaviourTreeSnapshot",
          "trace",
        ].includes(command.type)
      ) {
        window.parent.postMessage(
          { type: PREVIEW_CONSOLE_EVENT_MESSAGE, command },
          previewHostOrigin,
        );
      }
    },
    onStats: (stats) => {
      currentLightsDebugText = stats.lightsDebugText ?? null;
      hud.setStats({ ...stats, ...hostMemory });
      setRootState({
        booted: stats.ticks > 0,
        ticks: stats.ticks,
        startupScene: game.manifest.startupSceneGuid,
      });
      if (window.parent !== window) {
        window.parent.postMessage(
          {
            type: PREVIEW_STATS_MESSAGE,
            ticks: stats.ticks,
            scriptMs: stats.scriptMs,
            physicsMs: stats.physicsMs,
          },
          previewHostOrigin,
        );
      }
    },
    onDiagnostic: (diagnostics) => {
      if (window.parent === window) return;
      window.parent.postMessage(
        { type: PREVIEW_DIAGNOSTICS_MESSAGE, diagnostics },
        previewHostOrigin,
      );
    },
  }).catch((error: unknown) => {
    window.clearInterval(memoryInterval);
    stopAudioOverlays();
    throw error;
  });
  if (startupAbort.signal.aborted) {
    try { session.stop(); } finally {
      window.clearInterval(memoryInterval);
      stopAudioOverlays();
    }
    return;
  }
  rootEl().dataset.requestedBackend = session.backend.requestedBackend;
  rootEl().dataset.effectiveBackend = session.backend.effectiveBackend;
  rootEl().dataset.backendFallback = session.backend.fallbackReason ?? "";
  const layoutObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => layoutFromManifest(game.manifest));
  layoutObserver?.observe(rootEl());
  if (import.meta.env.VITE_TEST_MODE === "true") {
    (
      window as typeof window & {
        __babylonslatePlayerTest?: {
          visuals: () => ReturnType<typeof session.visuals>;
          meshMaterialNames: () => string[];
        };
      }
    ).__babylonslatePlayerTest = {
      visuals: () => session.visuals(),
      meshMaterialNames: () => session.meshMaterialNames(),
    };
  }
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        type: PREVIEW_CONSOLE_CATALOG_MESSAGE,
        commands: game.scripts.flatMap((script) =>
          script.command ? [script.command] : [],
        ),
        scenes: [...game.scenes.entries()].flatMap(([guid, scene]) => [
          guid,
          scene.name,
        ]),
        actors: [],
      },
      previewHostOrigin,
    );
    window.parent.postMessage(
      {
        type: PREVIEW_READY_MESSAGE,
        startupSceneGuid: game.manifest.startupSceneGuid,
      },
      previewHostOrigin,
    );
  }
  let inspecting = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopCurrentPlayer = undefined;
    window.removeEventListener("message", onSessionMessage);
    window.clearInterval(memoryInterval);
    layoutObserver?.disconnect();
    stopAudioOverlays();
    const result = session.stop();
    if (window.parent !== window && result.diagnostics.length > 0) {
      window.parent.postMessage(
        { type: PREVIEW_DIAGNOSTICS_MESSAGE, diagnostics: result.diagnostics },
        previewHostOrigin,
      );
    }
  };
  stopCurrentPlayer = stop;
  function onSessionMessage(event: MessageEvent) {
    if (!isExpectedPreviewHostMessage(event, window.parent, previewHostOrigin))
      return;
    if (stopped) return;
    if (previewMode() && event.data?.type === PREVIEW_CONSOLE_CONTEXT_MESSAGE) {
      if (inspecting) return;
      inspecting = true;
      void session
        .inspectWorld()
        .then((snapshot) => {
          if (stopped) return;
          const actors = [
            ...new Set(
              snapshot.nodes.flatMap((node) =>
                node.kind === "actor" ? [node.label, node.id] : [],
              ),
            ),
          ];
          window.parent.postMessage(
            { type: PREVIEW_CONSOLE_CATALOG_MESSAGE, actors },
            previewHostOrigin,
          );
        })
        .finally(() => {
          inspecting = false;
        });
      return;
    }
    if (
      previewMode() &&
      event.data?.type === PREVIEW_CONSOLE_REQUEST_MESSAGE &&
      isPreviewConsoleRequest(event.data)
    ) {
      const { requestId, line } = event.data;
      void session.executeConsoleCommand(line).then((result) => {
        window.parent.postMessage(
          { type: PREVIEW_CONSOLE_RESULT_MESSAGE, requestId, ...result },
          previewHostOrigin,
        );
      });
      return;
    }
  }
  window.addEventListener("message", onSessionMessage);
}

function previewMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("preview") === "1";
}

function bootFailure(error: unknown): void {
  if (startupAbort.signal.aborted) return;
  const message = error instanceof Error ? error.message : String(error);
  rootEl().dataset.error = message;
  if (window.parent !== window) {
    window.parent.postMessage(
      { type: PREVIEW_ERROR_MESSAGE, message },
      previewHostOrigin,
    );
  }
}

if (previewMode()) {
  let launched = false;
  window.addEventListener("message", (event) => {
    const pack = previewPackFromExpectedHostMessage(
      event,
      window.parent,
      previewHostOrigin,
    );
    if (!pack) return;
    // The host may resend the pack until it sees the player boot; ignore repeats.
    if (launched) return;
    launched = true;
    void launchFromFiles(filesFromPreviewPack(pack)).catch(bootFailure);
  });
  // Ask only once the listener above exists. Waiting for the parent's iframe
  // `load` event alone raced module evaluation and silently dropped the pack.
  if (window.parent !== window) {
    window.parent.postMessage(
      { type: PREVIEW_REQUEST_PACK_MESSAGE },
      previewHostOrigin,
    );
  }
} else {
  void launchFromHttp().catch(bootFailure);
}
