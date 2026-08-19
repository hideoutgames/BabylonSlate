import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** Babylon CubeTexture order. Keep in sync with `SKYBOX_FACE_KEYS` in core. */
export const ENGINE_DEFAULT_SKYBOX_FACE_FILES = [
  "px.png",
  "py.png",
  "pz.png",
  "nx.png",
  "ny.png",
  "nz.png",
] as const;

/** Copy engine default cubemap PNGs into an app `public/` tree. */
export function copyEngineDefaultSkyboxFaces(
  repoRoot: string,
  destPublicDir: string,
): void {
  const fromDir = path.join(repoRoot, "engine-content/skybox");
  const toDir = path.join(destPublicDir, "engine-content/skybox");
  mkdirSync(toDir, { recursive: true });
  for (const file of ENGINE_DEFAULT_SKYBOX_FACE_FILES) {
    const from = path.join(fromDir, file);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(toDir, file));
  }
}

export function engineDefaultSkyboxVitePlugin(
  repoRoot: string,
  destPublicDir: string,
): Plugin {
  const copy = () => copyEngineDefaultSkyboxFaces(repoRoot, destPublicDir);
  return {
    name: "copy-engine-default-skybox",
    buildStart: copy,
    configureServer: copy,
  };
}
