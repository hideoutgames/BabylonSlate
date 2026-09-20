import { build, Platform, Arch } from "electron-builder";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stageRenderer } from "./layout.mjs";
import { validateArtifacts } from "../../../scripts/distribution/contract.mjs";

if (process.platform !== "win32") throw new Error("Windows packaging requires Windows");
if (process.env.VITE_TEST_MODE === "true") throw new Error("Native distribution must use production storage");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(desktop, "../editor/dist/build-manifest.json"), "utf8"));
if (!['test', 'release'].includes(manifest.channel) || !manifest.windowsVersion) throw new Error("Distribution manifest required");
const stage = join(desktop, "dist/app");
try { await access(stage); throw new Error("Packaging stage already exists; use a clean checkout"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(stage, { recursive: true });
await cp(join(desktop, "dist/host"), join(stage, "host"), { recursive: true });
await stageRenderer(join(desktop, "../editor/dist"), join(stage, "renderer"));
await writeFile(join(stage, "package.json"), JSON.stringify({ name: "babylonslate", productName: "BabylonSlate", version: manifest.windowsVersion, main: "host/main.cjs", description: "BabylonSlate editor", author: "Hideout Games" }, null, 2));
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
await build({ projectDir: desktop, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never", config: join(desktop, "electron-builder.yml") });
const output = join(desktop, "dist/installers");
const publicDir = join(desktop, "dist/public");
await mkdir(publicDir, { recursive: true });
const installer = `BabylonSlate-${manifest.windowsVersion}-x64.exe`;
const bytes = await readFile(join(output, installer));
await writeFile(join(publicDir, installer), bytes);
await writeFile(join(publicDir, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const metadata = await readFile(join(publicDir, "build-manifest.json"));
await writeFile(join(publicDir, "SHA256SUMS.txt"), [ [installer, bytes], ["build-manifest.json", metadata] ].map(([name, contents]) => `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`).join(""));
validateArtifacts(manifest.windowsVersion, await readdir(publicDir));
