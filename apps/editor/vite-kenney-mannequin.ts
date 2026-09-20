import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const MANNEQUIN_FILES = ["mannequin.glb", "mannequin.png"] as const;

/** Copy Kenney Mannequin GLB + albedo PNG into editor public/ for fetch + Playwright. */
export function kenneyMannequinVitePlugin(options: {
  sourceDir: string;
  publicDir: string;
}): Plugin {
  function copy(): void {
    mkdirSync(options.publicDir, { recursive: true });
    for (const name of MANNEQUIN_FILES) {
      copyFileSync(
        path.join(options.sourceDir, name),
        path.join(options.publicDir, name),
      );
    }
  }
  return {
    name: "babylonslate-kenney-mannequin",
    buildStart() {
      copy();
    },
    configureServer() {
      copy();
    },
  };
}
