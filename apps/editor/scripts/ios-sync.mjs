import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const configPath = new URL(
  "../ios/App/App/capacitor.config.json",
  import.meta.url,
);
const podfilePath = new URL("../ios/App/Podfile", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));
const packageClassList = new Set(config.packageClassList ?? []);
packageClassList.add("BabylonSlateSecretsPlugin");
config.packageClassList = [...packageClassList];
await writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`);

const podfile = await readFile(podfilePath, "utf8");
const repairedPodfile = podfile.replaceAll(
  "DanieleRolliCapacitorScopedStorage",
  "CapacitorScopedStorage",
);
const capSyncStatus = Number(process.env.CAP_SYNC_STATUS ?? 0);
if (repairedPodfile !== podfile) {
  await writeFile(podfilePath, repairedPodfile);
}
if (capSyncStatus !== 0 || repairedPodfile !== podfile) {
  execFileSync("pod", ["install"], {
    cwd: fileURLToPath(new URL("../ios/App/", import.meta.url)),
    stdio: "inherit",
  });
}
if (capSyncStatus !== 0 && repairedPodfile === podfile) {
  throw new Error(`cap sync ios failed with status ${capSyncStatus}`);
}
