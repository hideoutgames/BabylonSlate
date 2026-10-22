import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { enginePluginsVitePlugin } from "./vite-engine-plugins.ts";
import { kenneyMannequinVitePlugin } from "./vite-kenney-mannequin.ts";
import { engineDefaultSkyboxVitePlugin } from "./vite-engine-skybox.ts";
import { engineBillboardsVitePlugin } from "./vite-engine-billboards.ts";
import { featureTestEngineContentVitePlugin } from "./vite-engine-content.ts";
import { playerHostVitePlugin } from "./vite-player-host.ts";
import { validateChangelog, validatePatchNotes } from "../../scripts/distribution/changelog.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const manifestPath = path.join(rootDir, "public/build-manifest.json");
const distributionBuild = process.env.BABYLONSLATE_DISTRIBUTION === "true";
const queryTestPermitted = process.env.VITE_TEST_QUERY === "true";
// Editor-edit profiling builds use React's profiling renderer so test-mode
// Profilers report commit timings (.agents/reference/testing.md).
const reactProfiling = process.env.VITE_REACT_PROFILING === "true";
if (
  distributionBuild &&
  (!existsSync(manifestPath) ||
    process.env.VITE_TEST_MODE === "true" ||
    queryTestPermitted)
) {
  throw new Error("Distribution requires build metadata and production storage");
}
if (distributionBuild && reactProfiling) {
  throw new Error("Distribution cannot use the React profiling build");
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
// Distribution builds name their channel as the manifest and release notes do.
const channelLabel =
  buildIdentity?.channel === "release"
    ? "Release"
    : buildIdentity?.channel === "test"
      ? "Test (Indev)"
      : "Development build";
const buildLabel = `${declaredVersion} ${channelLabel}`;
// The app shows the running version's notes. Distribution builds embed the copy
// preflight read from the exact source commit; other builds read the working tree.
const releaseNotes = buildIdentity
  ? validatePatchNotes(buildIdentity.patchNotes, declaredVersion)
  : (validateChangelog(
      JSON.parse(readFileSync(path.join(repoRoot, "release/changelog.json"), "utf8")),
      declaredVersion,
    ).find(notes => notes.version === declaredVersion) ?? null);

export default defineConfig({
  define: {
    __HAPTIC_BUILD__: JSON.stringify(buildIdentity),
    __HAPTIC_BUILD_LABEL__: JSON.stringify(buildLabel),
    __HAPTIC_VERSION__: JSON.stringify(declaredVersion),
    __HAPTIC_RELEASE_NOTES__: JSON.stringify(releaseNotes),
  },
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    {
      name: "slate-loading-build-label",
      transformIndexHtml: (html) => html.replace("__SLATE_BUILD_LABEL__", buildLabel),
    },
    {
      // Only a distribution build, which refuses test-mode storage, may ship the generated
      // manifest: native packaging and signing require it as proof of a production bundle.
      name: "slate-distribution-manifest",
      apply: "build",
      async writeBundle(options) {
        if (!distributionBuild && options.dir) {
          await rm(path.join(options.dir, "build-manifest.json"), { force: true });
        }
      },
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
    featureTestEngineContentVitePlugin(repoRoot, path.join(rootDir, "public")),
    playerHostVitePlugin(
      path.join(rootDir, "../player/dist"),
      path.join(rootDir, "dist"),
    ),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
      "@haptic/ui": path.resolve(rootDir, "../../packages/ui/src"),
      ...(reactProfiling ? { "react-dom/client": "react-dom/profiling" } : {}),
    },
  },
  // Workers build as ES modules, as in the player: the default IIFE inlines every dynamic import, which
  // would pull the lazily loaded Rapier 2D and Recast backends into the game worker's entry file. Every
  // bundled worker is constructed with `{ type: "module" }`; classic workers load from `public/` unbundled.
  worker: {
    format: "es",
  },
  // Localhost only by default; `--host` opts in to LAN access (see README).
  server: {
    port: 5173,
  },
});
