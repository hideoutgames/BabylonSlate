import type { GameManifest } from "@babylonslate/exporter";
import {
  getHostMemoryStats,
  type HostMemoryStats,
} from "@babylonslate/vfs";
import { loadGameFromFiles, loadGameFromHttp } from "./artifact";
import { startPlayerWithBackend } from "./player-backend";
import type { PlayerTestHandle } from "./boot";
import { mountPlayerHud, mountPlayerDebuggerOverlays } from "./hud";
import { applyPlayerLayout } from "./layout";
import {
  createPreviewAssetClient,
  PREVIEW_CONSOLE_REQUEST_MESSAGE,
  PREVIEW_CONSOLE_RESULT_MESSAGE,
  PREVIEW_CONSOLE_EVENT_MESSAGE,
  PREVIEW_CONSOLE_CATALOG_MESSAGE,
  PREVIEW_CONSOLE_CONTEXT_MESSAGE,
  isPreviewConsoleRequest,
  createPreviewSaveStorageClient,
} from "@babylonslate/exporter";
import {
  filesFromPreviewPack,
  isExpectedPreviewHostMessage,
  previewPackFromExpectedHostMessage,
  PREVIEW_DIAGNOSTICS_MESSAGE,
  PREVIEW_ERROR_MESSAGE,
  PREVIEW_READY_MESSAGE,
  PREVIEW_REQUEST_PACK_MESSAGE,
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

async function launchFromFiles(files: Map<string, Uint8Array>, traceByteBudget?: number, onDemand = false): Promise<void> {
  const source = onDemand ? createPreviewAssetClient({ send: message => window.parent.postMessage(message, previewHostOrigin) }) : undefined;
  const receive = (event: MessageEvent) => {
    if (isExpectedPreviewHostMessage(event, window.parent, previewHostOrigin)) source?.receive(event.data);
  };
  if (source) window.addEventListener("message", receive);
  const release = () => { source?.dispose(); window.removeEventListener("message", receive); };
  startupAbort.signal.addEventListener("abort", release, { once: true });
  try {
    const game = await loadGameFromFiles(files, { signal: startupAbort.signal, readFile: source?.readFile });
    const dispose = game.dispose;
    game.dispose = () => { try { dispose?.(); } finally { startupAbort.signal.removeEventListener("abort", release); release(); } };
    try { await launchLoaded(game, traceByteBudget); } catch (error) { game.dispose(); throw error; }
  } catch (error) { startupAbort.signal.removeEventListener("abort", release); release(); throw error; }
}

async function launchFromHttp(): Promise<void> {
  const game = await loadGameFromHttp(document.baseURI, fetch, startupAbort.signal);
  try { await launchLoaded(game); } catch (error) { game.dispose?.(); throw error; }
}

async function launchLoaded(
  game: Awaited<ReturnType<typeof loadGameFromFiles>>,
  traceByteBudget?: number,
): Promise<void> {
  startupAbort.signal.throwIfAborted();
  const canvas = canvasEl();
  let runtimeRender = game.manifest.render;
  layoutFromManifest(game.manifest);
  const hud = mountPlayerHud(
    document.getElementById("player-hud") ?? document.createElement("div"),
    // Preview Build starts with Stats closed, like Play; its overlay toggles them.
    { bundleDebugger: game.manifest.bundleDebugger, visible: !(previewMode() && window.parent !== window) },
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
  let stopped = false;
  let previewDiagnostics: ReturnType<typeof import("./preview-diagnostics")["installPreviewDiagnostics"]> | undefined;
  let preparingDiagnostics: Promise<void> | undefined;
  const previewSaves = previewMode() && window.parent !== window ? createPreviewSaveStorageClient({
    source: () => window.parent,
    origin: () => previewHostOrigin,
    send: (message) => window.parent.postMessage(message, previewHostOrigin),
  }) : null;
  const receiveSaveMessage = (event: MessageEvent) => previewSaves?.receive(event);
  if (previewSaves) window.addEventListener("message", receiveSaveMessage);
  let layoutObserver: ResizeObserver | null = null;
  const cleanupPage = () => {
    if (stopped) return;
    stopped = true;
    stopCurrentPlayer = undefined;
    rootEl().dataset.booted = "false";
    const errors: unknown[] = [];
    for (const release of [
      () => window.removeEventListener("message", receiveSaveMessage),
      () => previewSaves?.dispose(),
      () => window.removeEventListener("message", onSessionMessage),
      () => window.clearInterval(memoryInterval),
      () => layoutObserver?.disconnect(),
      () => { void previewDiagnostics?.close(); },
      stopAudioOverlays,
    ]) {
      try { release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Player page cleanup failed.");
  };

  const session = await startPlayerWithBackend({
    signal: startupAbort.signal,
    canvas,
    game,
    saveStorage: previewSaves?.storage,
    traceByteBudget,
    previewDiagnostics: previewMode() && window.parent !== window,
    onStopped: cleanupPage,
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
          "setShowFps",
          "setStat",
        ].includes(command.type)
      ) {
        window.parent.postMessage(
          { type: PREVIEW_CONSOLE_EVENT_MESSAGE, command },
          previewHostOrigin,
        );
      }
    },
    onRenderOutputChanged: (render) => {
      runtimeRender = render;
      applyPlayerLayout({ root: rootEl(), canvas: canvasEl(), render });
    },
    onStats: (stats) => {
      if (stopped) return;
      currentLightsDebugText = stats.lightsDebugText ?? null;
      hud.setStats({ ...stats, ...hostMemory });
      setRootState({
        booted: stats.ticks > 0,
        ticks: stats.ticks,
        startupScene: game.manifest.startupSceneGuid,
      });
    },
    onDiagnostic: (diagnostics) => {
      if (window.parent === window) return;
      window.parent.postMessage(
        { type: PREVIEW_DIAGNOSTICS_MESSAGE, diagnostics },
        previewHostOrigin,
      );
    },
  }).catch((error: unknown) => {
    try { cleanupPage(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Player page startup cleanup failed.", { cause: error });
    }
    throw error;
  });
  if (stopped || startupAbort.signal.aborted) {
    try { session.stop(); } finally { cleanupPage(); }
    return;
  }
  rootEl().dataset.requestedBackend = session.backend.requestedBackend;
  rootEl().dataset.effectiveBackend = session.backend.effectiveBackend;
  rootEl().dataset.backendFallback = session.backend.fallbackReason ?? "";
  layoutObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => applyPlayerLayout({ root: rootEl(), canvas: canvasEl(), render: runtimeRender }));
  layoutObserver?.observe(rootEl());
  if (import.meta.env.VITE_TEST_MODE === "true") {
    (
      window as typeof window & {
        __babylonslatePlayerTest?: PlayerTestHandle;
      }
    ).__babylonslatePlayerTest = {
      visuals: () => session.visuals(),
      rendering: () => session.rendering(),
      scalability: () => session.scalability(),
      shadowDiagnostics: () => session.shadowDiagnostics(),
      meshMaterialNames: () => session.meshMaterialNames(),
      postProcessPassCount: () => session.postProcessPassCount(),
      renderTasks: () => session.renderTasks(),
      setRenderSettings: (settings) => session.setRenderSettings(settings),
      executeConsoleCommand: (line) => session.executeConsoleCommand(line),
      stop: () => session.stop(),
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
  const stop = () => {
    if (stopped) return;
    let result: ReturnType<typeof session.stop>;
    try { result = session.stop(); } finally { cleanupPage(); }
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
    if (previewMode() && session.previewDiagnostics && event.data?.type === "babylonslate-preview-diagnostic-control") {
      if (previewDiagnostics) { previewDiagnostics.receive(event); return; }
      if (event.data?.action !== "open" || preparingDiagnostics) return;
      // This independently built entry is absent from ordinary exported games.
      // A runtime URL keeps the normal single-file player bundle unchanged.
      const url = new URL(import.meta.env.DEV ? "./src/preview-diagnostics.ts" : "./player-preview-diagnostics.js", document.baseURI).href;
      preparingDiagnostics = (async () => {
        const module = await import(/* @vite-ignore */ url) as typeof import("./preview-diagnostics");
        if (stopped) return;
        previewDiagnostics = module.installPreviewDiagnostics(session.previewDiagnostics!, {
          source: () => window.parent, origin: () => previewHostOrigin,
          send: (message, transfer) => window.parent.postMessage(message, previewHostOrigin, transfer ?? []),
        });
        previewDiagnostics.receive(event);
      })().catch((error: unknown) => { console.warn("Preview diagnostics could not load.", error); })
        .finally(() => { preparingDiagnostics = undefined; });
      return;
    }
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
    void launchFromFiles(filesFromPreviewPack(pack), pack.traceByteBudget, pack.onDemand).catch(bootFailure);
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
