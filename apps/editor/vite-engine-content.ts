import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import {
  FEATURE_TEST_ENGINE_CONTENT,
  FEATURE_TEST_OPTIONAL_SLOTS,
  FEATURE_TEST_SLOTS_MANIFEST,
} from "./src/lib/feature-test/engine-content-files";

/**
 * Copy the FeatureTest starter's repository content into an app `public/`
 * tree. Required files must exist; optional CC0 slots are copied when present
 * and listed in a manifest so the browser never probes missing URLs.
 */
export function copyFeatureTestEngineContent(
  repoRoot: string,
  destPublicDir: string,
): void {
  const copy = (relative: string) => {
    const to = path.join(destPublicDir, relative);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(repoRoot, relative), to);
  };
  for (const relative of FEATURE_TEST_ENGINE_CONTENT) {
    if (!existsSync(path.join(repoRoot, relative))) {
      throw new Error(`FeatureTest engine content is missing: ${relative}`);
    }
    copy(relative);
  }
  const present = Object.values(FEATURE_TEST_OPTIONAL_SLOTS)
    .flat()
    .filter((relative) => existsSync(path.join(repoRoot, relative)));
  for (const relative of present) copy(relative);
  const manifest = path.join(destPublicDir, FEATURE_TEST_SLOTS_MANIFEST);
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, `${JSON.stringify({ present }, null, 2)}\n`);
}

export function featureTestEngineContentVitePlugin(
  repoRoot: string,
  destPublicDir: string,
): Plugin {
  return {
    name: "copy-feature-test-engine-content",
    // Copy during config resolution so the dev server's publicDir whitelist
    // snapshot (built before configureServer) includes the files.
    configResolved: () => copyFeatureTestEngineContent(repoRoot, destPublicDir),
  };
}
