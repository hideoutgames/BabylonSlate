import type { GameManifest } from "@haptic/exporter";
import { loadGameFromFiles, loadGameFromHttp, type LoadedGame } from "./artifact";
import { createDecoderPrefetch } from "./decoder-paths";
import { startPlayerWithBackend, type PlayerBackendHandle } from "./player-backend";
import { prewarmPlayerWorker } from "./worker-host";

/** Where an exported game's files come from. */
export type GameSource =
  /** A published game: its catalog, then its assets, from beside its page. */
  | { baseUrl: string; fetchImpl: typeof fetch }
  /** Preview Build: the catalog the host handed over, and each asset read through the host. */
  | { files: Map<string, Uint8Array>; readFile: (path: string, signal: AbortSignal) => Promise<Uint8Array> };

/** Boots the loaded game on the launch's game worker; the launch supplies the game and its signal. */
export type BootLoadedGame = (
  options: Omit<Parameters<typeof startPlayerWithBackend>[0], "game" | "signal" | "takePrewarmedWorker">,
) => Promise<PlayerBackendHandle>;

/**
 * Load an exported game and hand it to `start`, which sets up the page and
 * boots it through `boot`. The game worker starts before the catalog request,
 * its physics engine loads once the catalog names the world, and the decoder
 * files the game's Textures and Models need download while the game does; the
 * player then boots on that worker. A worker the player never took is
 * terminated when the launch ends, and a game `start` failed to start is
 * disposed.
 */
export async function launchGame(options: {
  signal: AbortSignal;
  source: GameSource;
  start: (game: LoadedGame, boot: BootLoadedGame) => Promise<void>;
}): Promise<void> {
  const { signal, source } = options;
  const worker = prewarmPlayerWorker(signal);
  try {
    const hooks = {
      onManifest: (manifest: GameManifest) => worker?.preloadPhysics(manifest.physicsWorld),
      onDecoderNeeded: createDecoderPrefetch(),
    };
    const game = "files" in source
      ? await loadGameFromFiles(source.files, { signal, readFile: source.readFile, ...hooks })
      : await loadGameFromHttp(source.baseUrl, source.fetchImpl, signal, hooks);
    const boot: BootLoadedGame = (bootOptions) =>
      startPlayerWithBackend({ ...bootOptions, game, signal, takePrewarmedWorker: worker?.take });
    try { await options.start(game, boot); } catch (error) { game.dispose?.(); throw error; }
  } finally { worker?.release(); }
}
