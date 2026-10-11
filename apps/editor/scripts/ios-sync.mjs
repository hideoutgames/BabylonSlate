import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const editorDir = fileURLToPath(new URL("..", import.meta.url));
const configPath = new URL(
  "../ios/App/App/capacitor.config.json",
  import.meta.url,
);
const podfilePath = new URL("../ios/App/Podfile", import.meta.url);

const build = spawnSync("pnpm", ["build"], {
  cwd: editorDir,
  stdio: "inherit",
});
if (build.error || build.status !== 0) {
  throw (
    build.error ?? new Error(`pnpm build failed with status ${build.status}`)
  );
}

// Streamed rather than captured: CocoaPods output can exceed spawnSync's buffer.
const sync = spawnSync("pnpm", ["exec", "cap", "sync", "ios"], {
  cwd: editorDir,
  stdio: "inherit",
});
if (sync.error || sync.status !== 0) {
  throw (
    sync.error ?? new Error(`cap sync ios failed with status ${sync.status}`)
  );
}

// cap sync logs a failed web copy and still exits 0, leaving the previous bundle.
const webDir = join(editorDir, "dist");
const nativeWebDir = join(editorDir, "ios/App/App/public");
for (const entry of await readdir(webDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = relative(webDir, join(entry.parentPath, entry.name));
  const copied = await readFile(join(nativeWebDir, path)).catch(() => null);
  if (!copied?.equals(await readFile(join(webDir, path)))) {
    throw new Error(`cap sync ios did not copy ${path}; the native web bundle is stale`);
  }
}

const config = JSON.parse(await readFile(configPath, "utf8"));
const packageClassList = new Set(config.packageClassList ?? []);
packageClassList.add("BabylonSlateSecretsPlugin");
packageClassList.add("BabylonSlateScopedStoragePlugin");
packageClassList.add("BabylonSlateAudioLifecyclePlugin");
packageClassList.add("BabylonSlateMemoryPlugin");
config.packageClassList = [...packageClassList];
await writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`);

// cap sync rewrites only capacitor_pods; the App target and deployment-target hook must survive.
const podfile = await readFile(podfilePath, "utf8");
if (
  !/^target 'App' do\s*\n\s*capacitor_pods\b[\s\S]*?^end\b/m.test(podfile) ||
  !/^post_install do \|installer\|\s*\n\s*assertDeploymentTarget\(installer\)\s*\n\s*end\b/m.test(podfile)
) {
  throw new Error("Podfile lost its App target or post_install hook");
}
