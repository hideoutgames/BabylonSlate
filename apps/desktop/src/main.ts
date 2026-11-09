import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import { NodeSaveGameStorage } from "@haptic/vfs/save-game-node";
import { DesktopSaveGames } from "./desktop-save-games";
import type { ProjectFolderHandle } from "@haptic/core";
import { DesktopSecretStore, isMissingFile } from "./desktop-secret-store";
import { DesktopAccountSecretStore } from "./desktop-account-secrets";
import { fetchDesktopHttp, type DesktopHttpRequest } from "./desktop-http";
import { desktopMemoryStats } from "./desktop-memory";
import { createAuthBrowserSessions } from "./desktop-auth-browser";
import { createDiscordPresence, DISCORD_PRESENCE_PATH, handleDiscordPresenceRequest, type DiscordPresence } from "./discord-presence";
import { ownRuntimeZip, readBundledShell } from "./game-runtime";
import { macSigningIdentities, packageMacGame, type MacGamePackageRequest } from "./mac-game-package";
import {
  allowsEditorPermission,
  authProviderUrl,
  externalOpenUrl,
  isBillingFrameUrl,
  insidePreviewFrame,
  isEditorSender,
  isPreviewFrameUrl,
  knownProjectFolder,
  rendererFile,
  validateIpcArguments,
} from "./packaged-security";
import { automaticUpdatesEnabled, createDesktopUpdates, updatesSupported } from "./desktop-updates";
import { deleteDesktopProject, DesktopLibraries, libraryIpcHandlers, STORAGE_OPERATIONS } from "./desktop-storage-ipc";

const rootDir = join(app.getAppPath(), "host");
const rendererRoot = join(app.getAppPath(), "renderer");
const editorWindows = new Set<number>();
/** Each editor document owns the project folder it opened. */
const projectStorage = new Map<number, NodeStorageAdapter>();
let updates: ReturnType<typeof createDesktopUpdates> | undefined;
let saveGames: DesktopSaveGames | undefined;
/** Each editor document's user library folders, keyed by allowlisted scope. */
let libraries: DesktopLibraries | undefined;
/** Set once the primary instance has registered IPC and may open editor windows. */
let windowsAllowed = false;
/** Discord Rich Presence for Play, connected the first time a game sets it. */
let presence: DiscordPresence | null = null;
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
/** Third-party sign-in returns through the `haptic://sso-callback` deep link. */
const authBrowser = createAuthBrowserSessions({ openExternal: url => shell.openExternal(url) });
function focusEditorWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.focus();
}
// Windows and Linux start a second copy with the deep link as an argument.
app.on("second-instance", (_event, argv) => {
  for (const arg of argv) authBrowser.deliver(arg);
  focusEditorWindow();
});
// macOS hands the deep link to the running app.
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (authBrowser.deliver(url)) focusEditorWindow();
});
// macOS and Linux read the scheme from the packaged app's Info.plist and desktop entry.
if (app.isPackaged) app.setAsDefaultProtocolClient("haptic");
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!editorWindows.has(event.sender.id) || !isEditorSender(event.senderFrame?.url ?? "", event.senderFrame === event.sender.mainFrame)) throw new Error("Untrusted IPC sender");
    validateIpcArguments(channel, args);
    return listener(event, ...args);
  });
}

function userDataFile(name: string): string {
  return join(app.getPath("userData"), name);
}

/** Replace a host file in one rename, so a crash or a reader never sees a partial write. */
async function replaceFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Run read-modify-write tasks on one host file in call order. */
function serialized(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return task => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** A gone document's project folder, library binds and save leases end with it. */
function releaseOwner(owner: number): void {
  projectStorage.delete(owner);
  libraries?.releaseOwner(owner);
  void saveGames?.releaseOwner(owner);
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: join(rootDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contentsId = window.webContents.id;
  editorWindows.add(contentsId);
  window.on("closed", () => { editorWindows.delete(contentsId); releaseOwner(contentsId); });
  window.webContents.on("render-process-gone", () => releaseOwner(contentsId));
  // Fires once a new main-frame document commits; same-document navigations
  // and navigations that never commit keep the current page's state.
  window.webContents.on("did-navigate", () => releaseOwner(contentsId));
  // Windows can terminate an installer during shutdown/logoff. Keep it cached
  // for a subsequent normal exit instead.
  window.on("session-end", () => updates?.setEnabled(false));
  // Pricing, billing management and mail links open outside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalOpenUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isEditorSender(url, true)) event.preventDefault();
  });
  // Subframes may load the Preview player, or Web Billing checkout outside it.
  window.webContents.on("will-frame-navigate", event => {
    if (event.isMainFrame || isPreviewFrameUrl(event.url)) return;
    if (isBillingFrameUrl(event.url) && !insidePreviewFrame(event.frame)) return;
    event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  await window.loadURL("app://babylonslate/index.html");
}

async function registerIpc(): Promise<void> {
  // Listed, Documents and reopened project ids all use the canonical home, so a
  // userData path reached through a link still gives each project one id.
  const projectsRoot = join(app.getPath("userData"), "projects");
  await mkdir(projectsRoot, { recursive: true });
  const projectsHome = await realpath(projectsRoot);
  function projects(event: IpcMainInvokeEvent): NodeStorageAdapter {
    let storage = projectStorage.get(event.sender.id);
    if (!storage) {
      storage = new NodeStorageAdapter(projectsHome);
      projectStorage.set(event.sender.id, storage);
    }
    return storage;
  }
  saveGames = new DesktopSaveGames(new NodeSaveGameStorage(userDataFile("game-saves")));
  const saves = saveGames;
  handle("save-games:read", (event, key) => saves.result(() => saves.read(event.sender.id, String(key))));
  handle("save-games:write", (event, key, text) => saves.result(() => saves.write(event.sender.id, String(key), String(text))));
  handle("save-games:remove", (event, key) => saves.result(() => saves.remove(event.sender.id, String(key))));
  handle("save-games:list", (event, key) => saves.result(() => saves.list(event.sender.id, String(key))));
  handle("save-games:acquire-lock", (event, key) => saves.result(() => saves.acquire(event.sender.id, String(key))));
  handle("save-games:release-lock", (event, token) => saves.result(() => saves.release(event.sender.id, String(token))));
  const settingsPath = userDataFile("engine-settings.json");
  const grantsPath = userDataFile("project-folder-grants.json");
  const grantUpdates = serialized();
  async function grantedFolders(): Promise<string[]> {
    let json: string;
    try { json = await readFile(grantsPath, "utf8"); }
    catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    let grants: unknown;
    try { grants = JSON.parse(json); }
    catch { return []; }
    return Array.isArray(grants) ? grants.filter((grant): grant is string => typeof grant === "string") : [];
  }

  handle("memory:stats", (event) => desktopMemoryStats(app.getAppMetrics(), event.sender.getOSProcessId()));
  // Packaging a game for this computer's OS reuses this app's Electron runtime, laid out as Electron's release.
  handle("game-shell:runtime", async (_event, files, electronVersion) => {
    if (electronVersion !== process.versions.electron) throw new Error("This desktop app's Electron version does not match the game player's.");
    return ownRuntimeZip({ installDir: dirname(process.execPath), executablePath: process.execPath, files: files as string[], platform: process.platform });
  });
  // macOS games: signed with Apple's tools, so only the app on a Mac packages them.
  handle("game-shell:mac-identities", async () => process.platform === "darwin" ? macSigningIdentities() : []);
  handle("game-shell:package-mac", async (_event, request) => {
    if (process.platform !== "darwin") throw new Error("macOS games are packaged in the Haptic desktop app on a Mac.");
    return packageMacGame({ request: request as MacGamePackageRequest, ...await readBundledShell(rendererRoot, "macos-arm64") });
  });
  handle("settings:read", async () => {
    try {
      return await readFile(settingsPath, "utf8");
    } catch {
      return null;
    }
  });
  const settingsWrites = serialized();
  handle("settings:write", (_event, json) => settingsWrites(async () => {
    await replaceFile(settingsPath, String(json));
    updates?.setEnabled(automaticUpdatesEnabled(String(json)));
  }));

  const secretsPath = userDataFile("source-control-secrets.json");
  const secrets = new DesktopSecretStore(
    {
      read: () => readFile(secretsPath, "utf8"),
      write: contents => replaceFile(secretsPath, contents),
    },
    safeStorage,
  );

  handle("secrets:get", async (_event, key) => {
    return secrets.get(String(key));
  });
  handle("secrets:set", async (_event, key, value) => {
    await secrets.set(String(key), String(value));
  });
  handle("secrets:delete", async (_event, key) => {
    await secrets.delete(String(key));
  });

  const accountSecretsPath = userDataFile("account-secrets.json");
  const accountSecrets = new DesktopAccountSecretStore({
    read: () => readFile(accountSecretsPath, "utf8"),
    write: contents => replaceFile(accountSecretsPath, contents),
  }, safeStorage);
  handle("account-secrets:get", async (_event, key) => accountSecrets.get(String(key)));
  handle("account-secrets:set", async (_event, key, value) => accountSecrets.set(String(key), String(value)));
  handle("account-secrets:delete", async (_event, key) => accountSecrets.delete(String(key)));

  handle("lfs:fetch", async (_event, request) => {
    return fetchDesktopHttp(request as DesktopHttpRequest, (url, init) => net.fetch(url, init));
  });
  // Arguments are validated: a provider sign-in page and the sign-in callback.
  handle("auth:open-browser", (_event, url) => authBrowser.open(authProviderUrl(String(url))!));

  // Exports (themes, backups, packages, saves) ask where to save, starting in
  // Downloads, and resolve false when the user cancels.
  handle("file:save", async (event, name, data) => {
    const options = { defaultPath: join(app.getPath("downloads"), String(name)) };
    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return false;
    await writeFile(picked.filePath, Buffer.from(data as ArrayBuffer));
    return true;
  });

  handle("project:pickFolder", async event => {
    const storage = projects(event);
    const picked = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      throw new Error("Folder picker cancelled");
    }
    const selected = await realpath(picked.filePaths[0]);
    await grantUpdates(async () => {
      const grants = new Set(await grantedFolders());
      grants.add(selected);
      await replaceFile(grantsPath, JSON.stringify([...grants]));
    });
    return storage.openAbsoluteFolder(selected);
  });
  handle("project:openDocuments", async (event, name) => {
    return projects(event).openDocumentsProject(String(name));
  });
  handle("project:openKnown", async (event, handle) => {
    const storage = projects(event);
    const folder = handle as ProjectFolderHandle;
    const target = await knownProjectFolder(folder.id, projectsHome, grantedFolders);
    return storage.openAbsoluteFolder(target, folder.name, folder.tier);
  });
  handle("project:list", async event => projects(event).listProjects());
  handle("project:delete", async (event, handle) =>
    deleteDesktopProject(projectStorage, event.sender.id, projects(event), handle as ProjectFolderHandle));
  handle("project:release", async event => projects(event).releaseFolder());
  for (const [operation, run] of Object.entries(STORAGE_OPERATIONS)) {
    handle(`project:${operation}`, (event, ...args) => run(projects(event), ...args));
  }

  // User libraries are real folders beside `projects`, never inside it, so the
  // project list and project reopen checks never reach them.
  const librariesRoot = join(app.getPath("userData"), "libraries");
  await mkdir(librariesRoot, { recursive: true });
  libraries = new DesktopLibraries(await realpath(librariesRoot));
  for (const [channel, listener] of Object.entries(libraryIpcHandlers(libraries))) {
    handle(channel, (event, scope, ...args) => listener(event.sender.id, scope, ...args));
  }
}

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(editorWindows.has(contents.id) && allowsEditorPermission(permission, details.requestingUrl, details.isMainFrame)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    contents !== null && editorWindows.has(contents.id) && allowsEditorPermission(permission, details.requestingUrl ?? "", details.isMainFrame));
  protocol.handle("app", async request => {
    try {
      // Play in the desktop editor sets Discord Rich Presence as a packaged desktop game does.
      const url = new URL(request.url);
      if (url.host === "babylonslate" && url.pathname === DISCORD_PRESENCE_PATH) {
        return handleDiscordPresenceRequest(request, "app://babylonslate", presence ??= createDiscordPresence());
      }
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
      const file = rendererFile(request.url, rendererRoot);
      const response = await net.fetch(pathToFileURL(file).href, { method: request.method });
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response(null, { status: 404 }); }
  });
  await registerIpc();
  if (app.isPackaged) {
    try {
      const manifest = JSON.parse(await readFile(join(rendererRoot, "build-manifest.json"), "utf8"));
      if (updatesSupported(process.platform, manifest, app.getVersion(), process.env)) {
        const { autoUpdater } = await import("electron-updater");
        updates = createDesktopUpdates(autoUpdater, error => console.warn("Automatic update failed:", error));
        // Missing settings default on; an unreadable file may hold an opt-out.
        updates.setEnabled(await readFile(userDataFile("engine-settings.json"), "utf8").then(
          automaticUpdatesEnabled,
          (error: unknown) => isMissingFile(error),
        ));
      }
    } catch (error) { console.warn("Automatic updates unavailable:", error); }
  }
  windowsAllowed = true;
  await createWindow();
});

app.on("will-quit", () => presence?.dispose());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// A quitting second instance, or a primary still starting up, never opens a window here.
app.on("activate", () => {
  if (windowsAllowed && BrowserWindow.getAllWindows().length === 0) void createWindow();
});
