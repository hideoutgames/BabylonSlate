import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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

const sync = spawnSync("pnpm", ["exec", "cap", "sync", "ios"], {
  cwd: editorDir,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});
if (sync.status !== 0) {
  const syncOutput = `${sync.stdout ?? ""}${sync.stderr ?? ""}`;
  process.stderr.write(syncOutput);
  throw (
    sync.error ?? new Error(`cap sync ios failed with status ${sync.status}`)
  );
}
if (sync.stdout) process.stdout.write(sync.stdout);
if (sync.stderr) process.stderr.write(sync.stderr);

const config = JSON.parse(await readFile(configPath, "utf8"));
const packageClassList = new Set(config.packageClassList ?? []);
packageClassList.add("BabylonSlateSecretsPlugin");
packageClassList.add("BabylonSlateScopedStoragePlugin");
config.packageClassList = [...packageClassList];
await writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`);

const podfile = await readFile(podfilePath, "utf8");
if (!podfile.includes("end")) {
  throw new Error("Podfile appears truncated");
}
