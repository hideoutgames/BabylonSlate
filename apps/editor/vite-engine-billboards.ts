import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { ENGINE_BILLBOARD_FILES } from "../../packages/render/src/default-billboard/urls";

/** Copy engine editor billboard PNGs into an app `public/` tree. */
export function copyEngineBillboards(
  repoRoot: string,
  destPublicDir: string,
): void {
  const fromDir = path.join(repoRoot, "engine-content/billboards");
  const toDir = path.join(destPublicDir, "engine-content/billboards");
  mkdirSync(toDir, { recursive: true });
  for (const file of ENGINE_BILLBOARD_FILES) {
    const from = path.join(fromDir, file);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(toDir, file));
  }
}

export function engineBillboardsVitePlugin(
  repoRoot: string,
  destPublicDir: string,
): Plugin {
  const copy = () => copyEngineBillboards(repoRoot, destPublicDir);
  return {
    name: "copy-engine-billboards",
    buildStart: copy,
    configureServer: copy,
  };
}
