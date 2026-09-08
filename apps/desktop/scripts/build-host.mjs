import { build } from "esbuild";
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
