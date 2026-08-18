import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { SKYBOX_FACE_KEYS } from "@babylonslate/core";

/** Copy engine default cubemap PNGs into an app `public/` tree. */
export function copyEngineDefaultSkyboxFaces(
  repoRoot: string,
  destPublicDir: string,
): void {
  const fromDir = path.join(repoRoot, "engine-content/skybox");
  const toDir = path.join(destPublicDir, "engine-content/skybox");
  mkdirSync(toDir, { recursive: true });
  for (const key of SKYBOX_FACE_KEYS) {
    const from = path.join(fromDir, `${key}.png`);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(toDir, `${key}.png`));
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
