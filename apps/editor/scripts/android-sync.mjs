import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const editorDir = fileURLToPath(new URL("..", import.meta.url));

function run(args, label) {
  const result = spawnSync("pnpm", args, { cwd: editorDir, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${label} failed with status ${result.status}`);
  }
}

run(["build"], "pnpm build");
run(["exec", "cap", "sync", "android"], "cap sync android");

// cap sync logs a failed web copy and still exits 0, leaving the previous bundle.
const webDir = join(editorDir, "dist");
const nativeWebDir = join(editorDir, "android/app/src/main/assets/public");
for (const entry of await readdir(webDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = relative(webDir, join(entry.parentPath, entry.name));
  const copied = await readFile(join(nativeWebDir, path)).catch(() => null);
  if (!copied?.equals(await readFile(join(webDir, path)))) {
    throw new Error(`cap sync android did not copy ${path}; the native web bundle is stale`);
  }
}
