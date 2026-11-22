/**
 * An exported game's worker: its scripts come from the game's static scripts module (`createStaticModuleLoader`), which
 * the `load` message names by URL and the worker imports once. That module is a leaf (no imports) loaded by URL, never a
 * chunk of this build, so the import cannot re-evaluate this entry on WebKit. Nothing here evaluates text.
 */
import type { GameScriptsModule } from "@haptic/core";
import { startRuntimeWorker } from "./runtime-worker";
import { createStaticModuleLoader } from "./static-module-loader";
// The physics backends belong in this entry's chunk (`worker-entry.ts`).
import "@haptic/physics/havok-backend";
import "@haptic/physics/rapier-backend";

startRuntimeWorker((load) => createStaticModuleLoader(() => {
  const url = load?.scriptsModuleUrl;
  if (!url) return Promise.reject(new Error("This game has no scripts module; rebuild the game."));
  return import(/* @vite-ignore */ url) as Promise<GameScriptsModule>;
}));
