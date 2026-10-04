// Inspection identities are never published.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildManifest } from "./metadata.mjs";
import { validateChangelog } from "./changelog.mjs";

const platform = process.argv[2];
const channel = process.argv[3];
if (!["windows", "macos", "linux"].includes(platform) || !["test", "release"].includes(channel)) throw new Error("Usage: inspect-identity.mjs <windows|macos|linux> <test|release>");
const declared = JSON.parse(await readFile("release/version.json", "utf8"));
const root = JSON.parse(await readFile("package.json", "utf8"));
const desktop = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
const patchNotes = channel === "release"
  ? validateChangelog(JSON.parse(await readFile("release/changelog.json", "utf8")), declared.version).find(item => item.version === declared.version)
  : undefined;
const manifest = buildManifest(declared, {
  channel,
  platforms: "all",
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runNumber: Number(process.env.GITHUB_RUN_NUMBER ?? 1),
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
  platform,
  ...(platform === "macos" ? { macosSigned: false } : {}),
  ...(patchNotes ? { patchNotes } : {}),
  toolchains: { node: process.versions.node, pnpm: root.packageManager.split("@")[1], electron: desktop.devDependencies.electron },
});
const contents = JSON.stringify(manifest, null, 2) + "\n";
await mkdir("release/generated", { recursive: true });
await writeFile(`release/generated/${platform}-manifest.json`, contents);
await writeFile("apps/editor/public/build-manifest.json", contents);
