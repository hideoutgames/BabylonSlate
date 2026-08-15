import type { GameManifest } from "@babylonslate/exporter";
import { loadGameFromFiles, loadGameFromHttp } from "./artifact";
import { startPlayer } from "./boot";
import { mountPlayerHud, unlockAudioOnFirstGesture } from "./hud";
import { applyPlayerLayout } from "./layout";
import {
  filesFromPreviewPack,
  isPreviewPackMessage,
  PREVIEW_DIAGNOSTICS_MESSAGE,
  PREVIEW_READY_MESSAGE,
  PREVIEW_STATS_MESSAGE,
  PREVIEW_STOP_MESSAGE,
} from "./preview-protocol";

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

async function registerPackedFonts(
  fontBytes: Map<string, Uint8Array>,
): Promise<void> {
  if (typeof FontFace === "undefined" || !document.fonts) return;
  for (const [guid, bytes] of fontBytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: "font/ttf" });
    const url = URL.createObjectURL(blob);
    try {
      const face = new FontFace(guid, `url(${url})`);
      document.fonts.add(await face.load());
    } catch {
      URL.revokeObjectURL(url);
    }
  }
}

async function launchLoaded(
  game: Awaited<ReturnType<typeof loadGameFromFiles>>,
): Promise<void> {
  await registerPackedFonts(game.fontBytes);
  const canvas = canvasEl();
  layoutFromManifest(game.manifest);
  const hud = mountPlayerHud(
    document.getElementById("player-hud") ?? document.createElement("div"),
    { bundleDebugger: game.manifest.bundleDebugger },
  );
  setRootState({
    booted: false,
    ticks: 0,
    startupScene: game.manifest.startupSceneGuid,
  });
  const session = startPlayer({
    canvas,
    game,
    onStats: (stats) => {
      hud.setStats(stats);
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
          "*",
        );
      }
    },
    onDiagnostic: (diagnostics) => {
      if (window.parent === window) return;
      window.parent.postMessage(
        { type: PREVIEW_DIAGNOSTICS_MESSAGE, diagnostics },
        "*",
      );
    },
  });
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        type: PREVIEW_READY_MESSAGE,
        startupSceneGuid: game.manifest.startupSceneGuid,
      },
      "*",
    );
  }
  window.addEventListener("message", (event) => {
    if (
      event.data &&
      typeof event.data === "object" &&
      (event.data as { type?: string }).type === PREVIEW_STOP_MESSAGE
    ) {
      const result = session.stop();
      if (window.parent !== window && result.diagnostics.length > 0) {
        window.parent.postMessage(
          { type: PREVIEW_DIAGNOSTICS_MESSAGE, diagnostics: result.diagnostics },
          "*",
        );
      }
    }
  });
}

function previewMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("preview") === "1";
}

unlockAudioOnFirstGesture();

function bootFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  rootEl().dataset.error = message;
}

if (previewMode()) {
  window.addEventListener("message", (event) => {
    if (!isPreviewPackMessage(event.data)) return;
    void launchFromFiles(filesFromPreviewPack(event.data)).catch(bootFailure);
  });
} else {
  void launchFromHttp().catch(bootFailure);
}
