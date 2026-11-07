import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDefaultScene, DEFAULT_RENDER_PROJECT_SETTINGS } from "@haptic/core";
import { exportGame, GAME_MANIFEST_FILE } from "@haptic/exporter";
import type { BridgeHostMessage } from "@haptic/bridge";
import type { LoadedGame } from "./artifact";
import type { PlayerBackendHandle } from "./player-backend";
import type { PlayerWorkerHost } from "./worker-host";

// The real player creates a graphics Engine; the launch only has to hand it the game and the worker.
const { startPlayerWithBackend } = vi.hoisted(() => ({ startPlayerWithBackend: vi.fn() }));
vi.mock("./player-backend", () => ({ startPlayerWithBackend }));
import { launchGame, type GameSource } from "./launch";

/** Worker starts, control posts and requests, in the order they happened. */
const events: string[] = [];

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
    events.push("worker");
  }
  postMessage(message: BridgeHostMessage) {
    if (message.channel !== "control") return;
    const control = message.payload;
    events.push(control.type === "preloadPhysics" ? `preloadPhysics ${control.physicsWorld}` : control.type);
  }
}

const encoder = new TextEncoder();
const PAGE = "https://game.example/my-game/index.html";

/** A 2D game whose startup Scene needs a Zstandard KTX2 Texture. */
async function exportedFiles() {
  const texture = new Uint8Array(64);
  texture.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  texture[44] = 2;
  const exported = await exportGame({ bundleDebugger: false, startupSceneGuid: "scene", physicsWorld: "2d", renderSettings: DEFAULT_RENDER_PROJECT_SETTINGS, scripts: [], assets: [
    { guid: "scene", type: "Scene", sceneGuid: "scene", requiredDependencies: ["texture"], bytes: encoder.encode(JSON.stringify(createDefaultScene())) },
    { guid: "texture", type: "Texture", sceneGuid: "scene", bytes: texture },
  ] });
  if (!exported.ok) throw new Error(exported.error);
  return exported.value.files;
}

/** The page's fetch: the game's files beside the page, and nothing else. */
function serve(files: Map<string, Uint8Array>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.slice("/my-game/".length);
    events.push(`fetch ${path}`);
    const bytes = files.get(path) as Uint8Array<ArrayBuffer> | undefined;
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

const canvas = {} as HTMLCanvasElement;
const player = {} as PlayerBackendHandle;

beforeEach(() => {
  events.length = 0;
  FakeWorker.instances = [];
  startPlayerWithBackend.mockReset();
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("document", { baseURI: PAGE });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  {
    name: "a published game",
    source: (files: Map<string, Uint8Array>): GameSource => ({ baseUrl: PAGE, fetchImpl: serve(files) }),
    catalog: [`fetch ${GAME_MANIFEST_FILE}`],
  },
  {
    name: "Preview Build",
    source: (files: Map<string, Uint8Array>): GameSource => ({
      files: new Map([[GAME_MANIFEST_FILE, files.get(GAME_MANIFEST_FILE)!]]),
      readFile: async (path) => { events.push(`read ${path}`); return files.get(path)!; },
    }),
    catalog: [],
  },
])("starts $name's worker before its catalog, loads its physics and decoders while it downloads, and boots it on that worker", async ({ source, catalog }) => {
  const files = await exportedFiles();
  // The decoder prefetch uses the page's fetch.
  vi.stubGlobal("fetch", serve(files));
  let taken: PlayerWorkerHost | undefined;
  startPlayerWithBackend.mockImplementation(async (options: { takePrewarmedWorker?: () => PlayerWorkerHost | undefined }) => {
    taken = options.takePrewarmedWorker?.();
    return player;
  });
  const signal = new AbortController().signal;
  let loaded: LoadedGame | undefined;
  let booted: PlayerBackendHandle | undefined;
  await launchGame({ signal, source: source(files), start: async (game, boot) => {
    events.push("start");
    loaded = game;
    booted = await boot({ canvas, traceByteBudget: 64 });
  } });

  expect(events.slice(0, catalog.length + 2)).toEqual(["worker", ...catalog, "preloadPhysics 2d"]);
  // The Zstandard Texture's decoder files are requested before the game is handed over.
  expect(events.slice(0, events.indexOf("start"))).toEqual(expect.arrayContaining(["fetch ktx2/babylon.ktx2Decoder.js", "fetch ktx2/zstddec.wasm"]));
  expect(startPlayerWithBackend).toHaveBeenCalledOnce();
  expect(startPlayerWithBackend).toHaveBeenCalledWith(expect.objectContaining({ canvas, traceByteBudget: 64, game: loaded, signal }));
  expect(booted).toBe(player);
  // The player took the launch's worker: no other starts, and the launch ending leaves it running.
  expect(FakeWorker.instances).toHaveLength(1);
  taken!.postControl({ type: "play" });
  expect(events.at(-1)).toBe("play");
  expect(FakeWorker.instances[0]!.terminate).not.toHaveBeenCalled();
});

it("terminates a worker the player never took, and disposes a game it failed to start", async () => {
  const files = await exportedFiles();
  vi.stubGlobal("fetch", serve(files));
  startPlayerWithBackend.mockRejectedValue(new Error("WebGL2 is not available."));
  let dispose: (() => void) | undefined;
  await expect(launchGame({ signal: new AbortController().signal, source: { baseUrl: PAGE, fetchImpl: serve(files) }, start: async (game, boot) => {
    dispose = game.dispose = vi.fn(game.dispose);
    await boot({ canvas });
  } })).rejects.toThrow("WebGL2 is not available.");
  expect(dispose).toHaveBeenCalledOnce();
  expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledOnce();

  // A game that never loads starts nothing, and its worker goes too.
  const start = vi.fn();
  await expect(launchGame({ signal: new AbortController().signal, source: { baseUrl: PAGE, fetchImpl: serve(new Map()) }, start }))
    .rejects.toThrow("Export is missing game.json");
  expect(start).not.toHaveBeenCalled();
  expect(FakeWorker.instances[1]!.terminate).toHaveBeenCalledOnce();
});
