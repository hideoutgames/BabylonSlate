import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll, listPackage } from "@electron/asar";
import { _electron, expect } from "@playwright/test";
import { stageRenderer } from "./layout.mjs";

if (process.platform !== "win32") throw new Error("Installed-app checks require Windows");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const repo = resolve(desktop, "../..");
const manifest = JSON.parse(await readFile(join(desktop, "dist/public/build-manifest.json"), "utf8"));
const sandbox = await mkdtemp(join(tmpdir(), "BabylonSlate-installed-check-"));
const installDir = join(sandbox, "installed");
const userData = join(sandbox, "user-data");
const installer = join(sandbox, "installer.exe");
const hidden = [];
let app;
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: sandbox, windowsHide: true, stdio: "pipe" });
  child.once("error", reject);
  child.once("close", code => code === 0 ? resolve() : reject(new Error("Installer command failed")));
});
try {
  await cp(join(desktop, `dist/public/BabylonSlate-${manifest.windowsVersion}-x64.exe`), installer);
  await run(installer, ["/S", `/D=${installDir}`]);
  await mkdir(userData);
  const archive = join(installDir, "resources/app.asar");
  const names = listPackage(archive).map(name => name.replaceAll("\\", "/").replace(/^\//, ""));
  for (const name of names) {
    assert.ok(/^(?:package.json|host(?:\/|$)|renderer(?:\/|$))/.test(name), "Unexpected packaged root");
    assert.ok(!/(?:^|\/)(?:\.env|\.git|node_modules)(?:\/|$)|\.(?:p8|p12|mobileprovision|ipa|keychain-db|babproject)$/i.test(name), "Forbidden packaged file");
  }
  const extracted = join(sandbox, "extracted");
  extractAll(archive, extracted);
  await stageRenderer(join(extracted, "renderer"), join(sandbox, "checked-renderer"));
  for (const name of names.filter(name => /\.(?:cjs|js|json)$/.test(name))) {
    const contents = await readFile(join(extracted, name), "utf8");
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{70,}/.test(contents), "Credential pattern in package");
  }
  // Make the old repository-relative renderer layout unavailable during launch.
  // Both source and destination are checked, generated directories in this checkout.
  for (const relativePath of ["apps/editor/dist", "apps/player/dist"]) {
    const source = resolve(repo, relativePath);
    const destination = `${source}.distribution-smoke-hidden`;
    assert.ok(!relative(repo, source).startsWith("..") && dirname(source) === dirname(destination));
    await rename(source, destination);
    hidden.push([source, destination]);
  }
  const cleanEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT"]) if (process.env[key]) cleanEnv[key] = process.env[key];
  const launch = () => _electron.launch({ executablePath: join(installDir, "BabylonSlate.exe"), cwd: sandbox, args: [`--user-data-dir=${userData}`], env: cleanEnv, timeout: 60000 });
  app = await launch();
  assert.equal(resolve(await app.evaluate(({ app }) => app.getPath("userData"))), resolve(userData));
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), manifest.windowsVersion);
  let page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  await expect(page.getByTestId("homepage")).toBeVisible();
  assert.equal(page.url(), "app://babylonslate/index.html");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-about").click();
  await expect(page.getByTestId("build-identity")).toContainText(manifest.applicationVersion);
  await expect(page.getByTestId("build-identity")).toContainText(manifest.sourceSha);
  await expect(page.getByTestId("build-identity")).toContainText(manifest.channel === "test" ? "Test" : "Release");
  await page.keyboard.press("Escape");
  await page.getByTestId("create-project").click();
  await page.getByTestId("create-project-name").fill("DistributionSmoke");
  await page.getByTestId("create-project-app-documents").click();
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
  await page.getByTestId("content-browser-search").fill("main");
  await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute("data-scene-ready", "true");
  const workers = [];
  page.on("worker", worker => workers.push(worker.url()));
  await page.getByTestId("play-preview").click();
  await expect(page.getByTestId("play-overlay")).toBeVisible();
  await expect(page.getByTestId("play-canvas")).toBeVisible();
  await expect.poll(() => workers.length).toBeGreaterThan(0);
  await page.getByTestId("play-overlay-close").click();
  const wasmFiles = names.filter(name => name.startsWith("renderer/") && name.endsWith(".wasm"));
  assert.ok(wasmFiles.length > 0, "WebAssembly assets must be packaged");
  for (const name of wasmFiles) {
    await page.evaluate(async resource => {
      const response = await fetch(`app://babylonslate/${resource}`);
      if (!response.ok) throw new Error("Packaged wasm fetch failed");
      await WebAssembly.compileStreaming(response);
    }, name.slice("renderer/".length));
  }
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
  const player = page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-root");
  await expect(player).toHaveAttribute("data-booted", "true");
  await expect(player).not.toHaveAttribute("data-error", /.+/);
  await expect.poll(() => player.getAttribute("data-ticks")).not.toBe("0");
  await page.getByTestId("preview-build-close").click();
  await page.evaluate(async () => { await window.babylonslate.project.writeBinary("distribution-smoke.bin", new Uint8Array([17, 42, 99]).buffer); });
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId(/^open-listed-project-DistributionSmoke(?:\.babproject)?$/).click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
  assert.deepEqual(await page.evaluate(async () => [...new Uint8Array(await window.babylonslate.project.readBinary("distribution-smoke.bin"))]), [17, 42, 99]);
  console.log("Installed Windows checks passed: identity, production storage/persistence, editor, player, workers, wasm, and package allowlist.");
} finally {
  if (app) await app.close().catch(() => {});
  for (const [source, destination] of hidden.reverse()) await rename(destination, source);
  // Only this invocation's checked temporary installation is removed.
  assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
  const entries = await readdir(installDir).catch(() => []);
  const uninstaller = entries.find(name => /^Uninstall.*\.exe$/i.test(name));
  if (uninstaller) await run(join(installDir, uninstaller), ["/S"]).catch(() => {});
  await rm(sandbox, { recursive: true, force: true });
}
