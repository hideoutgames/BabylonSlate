import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { enginePluginsVitePlugin } from "./vite-engine-plugins.ts";
import { kenneyMannequinVitePlugin } from "./vite-kenney-mannequin.ts";
import { engineDefaultSkyboxVitePlugin } from "./vite-engine-skybox.ts";
import { engineBillboardsVitePlugin } from "./vite-engine-billboards.ts";
import { playerHostVitePlugin } from "./vite-player-host.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const manifestPath = path.join(rootDir, "public/build-manifest.json");
const distributionBuild = process.env.BABYLONSLATE_DISTRIBUTION === "true";
if (distributionBuild && (!existsSync(manifestPath) || process.env.VITE_TEST_MODE === "true")) {
  throw new Error("Distribution requires build metadata and production storage");
}
const declaredVersion = JSON.parse(
  readFileSync(path.join(repoRoot, "release/version.json"), "utf8"),
).version as string;
const buildIdentity = distributionBuild
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : null;
if (buildIdentity && buildIdentity.applicationVersion !== declaredVersion) {
  throw new Error("Build metadata and declared application version differ");
}
const buildLabel = `${declaredVersion} ${buildIdentity?.channel === "release" ? "Release" : "Development build"}`;

export default defineConfig({
  define: {
    __BABYLONSLATE_BUILD__: JSON.stringify(buildIdentity),
    __BABYLONSLATE_BUILD_LABEL__: JSON.stringify(buildLabel),
  },
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    {
      name: "slate-loading-build-label",
      transformIndexHtml: (html) => html.replace("__SLATE_BUILD_LABEL__", buildLabel),
    },
    react(),
    tailwindcss(),
    enginePluginsVitePlugin({
      sourceDir: path.join(repoRoot, "engine-plugins"),
      publicDir: path.join(rootDir, "public/engine-plugins"),
    }),
    kenneyMannequinVitePlugin({
      sourceDir: path.join(repoRoot, "engine-content/kenney-assets/Mannequin"),
      publicDir: path.join(
        rootDir,
        "public/engine-content/kenney-assets/Mannequin",
      ),
    }),
    engineDefaultSkyboxVitePlugin(repoRoot, path.join(rootDir, "public")),
    engineBillboardsVitePlugin(repoRoot, path.join(rootDir, "public")),
    playerHostVitePlugin(
      path.join(rootDir, "../player/dist"),
      path.join(rootDir, "dist"),
    ),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
      "@babylonslate/ui": path.resolve(rootDir, "../../packages/ui/src"),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
