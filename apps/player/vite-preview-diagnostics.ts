import path from "node:path";
import { build, type Plugin } from "vite";

/** Keep the existing ordinary player monolith unchanged. This independent
 * Preview entry has only transport/collector code and uses injected game ports. */
export function previewDiagnosticsEntry(rootDir: string): Plugin {
  return {
    name: "preview-diagnostics-entry",
    apply: "build",
    async buildStart() {
      const result = await build({
        configFile: false,
        root: rootDir,
        publicDir: false,
        logLevel: "error",
        build: {
          write: false, target: "es2022", cssCodeSplit: false,
          lib: { entry: path.join(rootDir, "src/preview-diagnostics.ts"), formats: ["es"] },
          rolldownOptions: { output: { codeSplitting: false, entryFileNames: "player-preview-diagnostics.js" } },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const chunks = outputs.flatMap((output) => "output" in output ? output.output : []);
      if (chunks.length !== 1 || chunks[0]?.type !== "chunk") throw new Error("Preview diagnostics must produce one isolated JavaScript entry.");
      this.emitFile({ type: "asset", fileName: "player-preview-diagnostics.js", source: chunks[0].code });
    },
  };
}
