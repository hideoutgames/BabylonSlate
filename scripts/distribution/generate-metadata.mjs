import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { buildManifest } from "./metadata.mjs";

const declared = JSON.parse(await readFile("release/version.json", "utf8"));
const preflight = JSON.parse(process.env.DISTRIBUTION_IDENTITY ?? "null");
if (!preflight || preflight.applicationVersion !== declared.version) throw new Error("Validated identity and source version differ");
const actualSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (actualSha !== preflight.sourceSha) throw new Error("Checked out source differs from preflight");
if (process.env.VITE_TEST_MODE === "true") throw new Error("Native distribution requires production storage");
const platform = process.argv[2];
if (!["windows", "ipados"].includes(platform)) throw new Error("Explicit platform required");
const root = JSON.parse(await readFile("package.json", "utf8"));
const desktop = JSON.parse(await readFile("apps/desktop/package.json", "utf8"));
const toolchains = { node: process.versions.node, pnpm: root.packageManager.split("@")[1] };
if (platform === "windows") toolchains.electron = desktop.devDependencies.electron;
else {
  const versions = JSON.parse(await readFile(process.env.APPLE_TOOLCHAIN_FILE, "utf8"));
  Object.assign(toolchains, versions);
}
const manifest = buildManifest(declared, { ...preflight, runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), toolchains });
const contents = JSON.stringify(manifest, null, 2) + "\n";
await mkdir("release/generated", { recursive: true });
await writeFile(`release/generated/${platform}-manifest.json`, contents);
await writeFile("apps/editor/public/build-manifest.json", contents);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `identity=${JSON.stringify(manifest)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${platform}: ${manifest.windowsVersion}; Apple ${manifest.appleBuildNumber}; source \`${actualSha}\`; actual build attempt ${manifest.runAttempt}.\n`);
