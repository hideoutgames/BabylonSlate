/**
 * Editor Play's game worker: compiles each script from its source text (`functionModuleLoader`), so a recompiled graph
 * runs at once. Exported games use `game-worker-entry.ts`.
 */
import { functionModuleLoader } from "./function-module-loader";
import { startRuntimeWorker } from "./runtime-worker";
// The physics backends belong in this entry's chunk. Loaded lazily, their chunk imports code this entry also uses from
// the entry chunk itself, and WebKit evaluates that import as a second copy of the whole worker, which then answers
// messages as a runtime that never started ("Runtime is unavailable.", "Stale session generation.").
import "@haptic/physics/havok-backend";
import "@haptic/physics/rapier-backend";

startRuntimeWorker(() => functionModuleLoader);
