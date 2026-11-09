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
// The Android and iOS project templates the main process copies to build mobile games.
for (const template of ["android-game", "ios-game"]) {
  await rm(join(desktop, "dist/host", template), { recursive: true, force: true });
  await cp(join(desktop, template), join(desktop, "dist/host", template), { recursive: true });
}
