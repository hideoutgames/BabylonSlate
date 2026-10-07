/* global window -- page.evaluate callbacks run in the packaged renderer */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAll, listPackage } from "@electron/asar";
import { _electron, expect as baseExpect } from "@playwright/test";
import { stageRenderer } from "./layout.mjs";

// Cold installed-app launches on hosted runners exceed Playwright's 5 s assertion default.
const expect = baseExpect.configure({ timeout: 60000 });

const platform = process.argv[2];
const hosts = { windows: "win32", macos: "darwin", linux: "linux" };
if (!hosts[platform] || process.platform !== hosts[platform]) throw new Error(`${platform || "Desktop"} installed-app checks require their native host`);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const repo = resolve(desktop, "../..");
const manifest = JSON.parse(await readFile(join(desktop, "dist/public/build-manifest.json"), "utf8"));
if (manifest.platform !== platform) throw new Error("Packaged manifest platform differs from smoke host");
const sandbox = await mkdtemp(join(tmpdir(), "BabylonSlate-installed-check-"));
const installDir = join(sandbox, "installed");
const userData = join(sandbox, "user-data");
const hidden = [];
const diagnostics = [];
let executable;
let archive;
let app;
let installer;
let dmgMounted = false;
const run = (command, args, cwd = sandbox) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: "pipe" });
  child.once("error", reject);
  child.once("close", code => code === 0 ? resolvePromise() : reject(new Error(`Command failed: ${command}`)));
});
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
async function cleanupStep(label, operation) {
  try {
    await operation();
  } catch (error) {
    console.warn(`${label}: ${error instanceof Error ? error.message : "cleanup failed"}`);
  }
}
let failure;
try {
  if (platform === "windows") {
    installer = join(sandbox, "installer.exe");
    await cp(join(desktop, `dist/public/BabylonSlate-${manifest.packageVersion}-x64.exe`), installer);
    await run(installer, ["/S", `/D=${installDir}`]);
    executable = join(installDir, "BabylonSlate.exe");
    archive = join(installDir, "resources/app.asar");
  } else if (platform === "macos") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const zip = join(desktop, `dist/public/BabylonSlate-${manifest.packageVersion}-${arch}.zip`);
    await mkdir(installDir);
    await run("ditto", ["-x", "-k", zip, installDir]);
    executable = join(installDir, "BabylonSlate.app/Contents/MacOS/BabylonSlate");
    archive = join(installDir, "BabylonSlate.app/Contents/Resources/app.asar");
    const mount = join(sandbox, "dmg");
    await mkdir(mount);
    const dmg = join(desktop, `dist/public/BabylonSlate-${manifest.packageVersion}-${arch}.dmg`);
    await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", mount, dmg]);
    dmgMounted = true;
    await access(join(mount, "BabylonSlate.app/Contents/Info.plist"));
    await run("hdiutil", ["detach", mount]);
    dmgMounted = false;
  } else {
    const appImage = join(sandbox, `BabylonSlate-${manifest.packageVersion}-x64.AppImage`);
    await cp(join(desktop, `dist/public/BabylonSlate-${manifest.packageVersion}-x64.AppImage`), appImage);
    await chmod(appImage, 0o755);
    await run(appImage, ["--appimage-extract"]);
    executable = join(sandbox, "squashfs-root/babylonslate");
    archive = join(sandbox, "squashfs-root/resources/app.asar");
  }
  await mkdir(userData);
  await writeFile(join(userData, "engine-settings.json"), JSON.stringify({ automaticUpdatesEnabled: false }));
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
  for (const relativePath of ["apps/editor/dist", "apps/player/dist"]) {
    const source = resolve(repo, relativePath);
    const destination = `${source}.distribution-smoke-hidden`;
    assert.ok(!relative(repo, source).startsWith("..") && dirname(source) === dirname(destination));
    await rename(source, destination);
    hidden.push([source, destination]);
  }
  const cleanEnv = {};
  const environmentKeys = platform === "windows"
    ? ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT"]
    : ["PATH", "HOME", "DISPLAY", "XAUTHORITY", "TMPDIR", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
  for (const key of environmentKeys) if (process.env[key]) cleanEnv[key] = process.env[key];
  // Hosted runners have no GPU; the launcher draws WebGL as soon as it boots.
  const chromiumArgs = ["--enable-unsafe-swiftshader"];
  // Extracted AppImages have no SUID sandbox helper on hosted runners.
  if (platform === "linux") chromiumArgs.push("--no-sandbox");
  const observe = launched => {
    const clip = text => String(text).slice(0, 300);
    launched.process().stderr?.on("data", chunk => diagnostics.push(`host: ${clip(chunk).trim()}`));
    const watch = window => {
      window.on("console", message => { if (message.type() === "error") diagnostics.push(`console: ${clip(message.text())}`); });
      window.on("pageerror", error => diagnostics.push(`page error: ${clip(error.message)}`));
      window.on("requestfailed", request => diagnostics.push(`request failed: ${clip(request.url())} ${request.failure()?.errorText ?? ""}`));
      window.on("response", response => { if (response.status() >= 400) diagnostics.push(`HTTP ${response.status()}: ${clip(response.url())}`); });
    };
    launched.windows().forEach(watch);
    launched.on("window", watch);
    return launched;
  };
  const launch = async () => observe(await _electron.launch({ executablePath: executable, cwd: sandbox, args: [`--user-data-dir=${userData}`, ...chromiumArgs], env: cleanEnv, timeout: 60000 }));
  app = await launch();
  // macOS reports the /private/var target of the /var temporary directory symlink.
  assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath("userData"))), await realpath(userData));
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), manifest.packageVersion);
  let page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  await expect(page.getByTestId("homepage")).toBeVisible();
  const news = page.getByRole("dialog", { name: "What's New" });
  await expect(news).toContainText(manifest.applicationVersion);
  await news.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(page.url(), "app://babylonslate/index.html");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-about").click();
  await expect(page.getByTestId("build-identity")).toContainText(manifest.applicationVersion);
  await expect(page.getByTestId("build-identity")).toContainText(manifest.sourceSha);
  await expect(page.getByTestId("build-identity")).toContainText(manifest.channel === "test" ? "Test" : "Release");
  await page.keyboard.press("Escape");
  await page.getByTestId("create-project").click();
  await page.getByTestId("create-project-empty").click();
  await page.getByTestId("create-project-name").fill("DistributionSmoke");
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
  await expect(page.getByRole("dialog", { name: "What's New" })).toHaveCount(0);
  await page.getByTestId(/^open-listed-project-DistributionSmoke(?:\.babproject)?$/).click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
  assert.deepEqual(await page.evaluate(async () => [...new Uint8Array(await window.babylonslate.project.readBinary("distribution-smoke.bin"))]), [17, 42, 99]);
  console.log(`Installed ${platform} checks passed: identity, production storage/persistence, editor, player, workers, wasm, and package allowlist.`);
} catch (error) {
  failure = error;
}
await cleanupStep("Packaged app close failed", async () => {
  if (app) await app.close();
});
for (const [source, destination] of hidden.reverse()) {
  await cleanupStep(`Renderer restore failed for ${relative(repo, source)}`, () => rename(destination, source));
}
await cleanupStep("DMG detach failed", async () => {
  if (dmgMounted) await run("hdiutil", ["detach", join(sandbox, "dmg")]);
});
if (platform === "windows") {
  await cleanupStep("Windows uninstall failed", async () => {
    const entries = await readdir(installDir).catch(() => []);
    const uninstaller = entries.find(name => /^Uninstall.*\.exe$/i.test(name));
    if (!uninstaller) return;
    await run(join(installDir, uninstaller), ["/S"]);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await access(installDir);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      await delay(500);
    }
    throw new Error("Timed out waiting for the NSIS uninstaller");
  });
}
await cleanupStep("Sandbox removal failed", async () => {
  assert.equal(dirname(resolve(sandbox)), resolve(tmpdir()));
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});
if (failure) {
  if (diagnostics.length) console.error(`Packaged app diagnostics (last ${Math.min(diagnostics.length, 40)}):\n${diagnostics.slice(-40).join("\n")}`);
  throw failure;
}
