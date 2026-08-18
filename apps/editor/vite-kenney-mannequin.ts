import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** Copy the Kenney Mannequin GLB into editor public/ for fetch + Playwright. */
export function kenneyMannequinVitePlugin(options: {
  sourceFile: string;
  publicFile: string;
}): Plugin {
  function copy(): void {
    mkdirSync(path.dirname(options.publicFile), { recursive: true });
    copyFileSync(options.sourceFile, options.publicFile);
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
