import { spawnSync } from "node:child_process";
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
