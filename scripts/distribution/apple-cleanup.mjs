import { access, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export function applePrivateDirectory(env = process.env) {
  const parent = resolve(env.RUNNER_TEMP || tmpdir());
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? "") || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("Apple distribution requires an explicit workflow run identity");
  const directory = resolve(parent, `babylonslate-apple-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  if (dirname(directory) !== parent) throw new Error("Invalid private output directory");
  return directory;
}

export async function cleanupApple(env = process.env) {
  const directory = applePrivateDirectory(env);
  try { await access(directory); } catch { return; }
  let failed = false;
  const originalPath = join(directory, "original-keychains.json");
  try {
    const original = JSON.parse(await readFile(originalPath, "utf8"));
    execFileSync("security", ["list-keychains", "-d", "user", "-s", ...original], { stdio: "ignore" });
  } catch (error) { if (error.code !== "ENOENT") failed = true; }
  try { execFileSync("security", ["delete-keychain", join(directory, "distribution.keychain-db")], { stdio: "ignore" }); } catch { /* No keychain may have been imported. */ }
  try {
    const uuid = (await readFile(join(directory, "installed-profile-uuid"), "utf8")).trim();
    if (!/^[A-Fa-f0-9-]{36}$/.test(uuid)) throw new Error("Invalid profile cleanup identity");
    for (const parent of [join(homedir(), "Library/MobileDevice/Provisioning Profiles"), join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles")]) await rm(join(parent, `${uuid}.mobileprovision`), { force: true });
  } catch (error) { if (error.code !== "ENOENT") failed = true; }
  await rm(directory, { recursive: true, force: true });
  if (failed) throw new Error("Apple credential cleanup was incomplete; private outputs were removed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await cleanupApple(); } catch { console.error("Apple cleanup failed; inspect the ephemeral runner privately"); process.exitCode = 1; }
}
