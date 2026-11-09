import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("..", import.meta.url));
await build({
  absWorkingDir: desktop,
  entryPoints: ["src/main.ts", "src/preload.ts"],
  outdir: "dist/host",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: false,
});
// The Android project template the main process copies to build Android games.
const androidTemplate = join(desktop, "dist/host/android-game");
await rm(androidTemplate, { recursive: true, force: true });
await cp(join(desktop, "android-game"), androidTemplate, { recursive: true });
