import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, Menu, net, protocol, session, shell } from "electron";
import { allowsGamePermission, gameExternalUrl, gameFile, GAME_HOST, isGameUrl } from "./packaged-security";

/**
 * The main process of an exported desktop game: one sandboxed window that
 * plays the web game from `resources/game` at `app://game/`. The game page
 * has no Node access and no preload; it cannot navigate away or open other
 * windows, and links it opens go to the system browser.
 */

interface GamePackage {
  productName?: unknown;
  hapticGameId?: unknown;
}

const gamePackage = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as GamePackage;
const title = typeof gamePackage.productName === "string" && gamePackage.productName.trim() ? gamePackage.productName.trim() : "Game";
const gameId = typeof gamePackage.hapticGameId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(gamePackage.hapticGameId) ? gamePackage.hapticGameId : null;
// Saves follow the project, not the game's name, so a renamed game keeps them.
if (gameId) app.setPath("userData", join(app.getPath("appData"), "Haptic Games", gameId));
const gameRoot = join(process.resourcesPath, "game");

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }]);

// One copy at a time: two would share the game's saves.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

let window: BrowserWindow | null = null;

app.on("second-instance", () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});
app.on("window-all-closed", () => app.quit());
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.on("will-navigate", (event, url) => {
    if (!isGameUrl(url)) event.preventDefault();
  });
  contents.on("will-frame-navigate", event => {
    if (!isGameUrl(event.url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const external = gameExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
});

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowsGamePermission(permission, details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) =>
    allowsGamePermission(permission, details.requestingUrl ?? ""));
  protocol.handle("app", async request => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
      const file = gameFile(request.url, gameRoot);
      const response = await net.fetch(pathToFileURL(file).href, { method: request.method });
      const headers = new Headers(response.headers);
      // The same isolation the editor and Preview Build give the player.
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response(null, { status: 404 }); }
  });
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1280,
    height: 720,
    title,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Games start their audio without waiting for a click, as installed apps do.
      autoplayPolicy: "no-user-gesture-required",
      // No spellchecker, so the game never fetches dictionaries from Google's servers.
      spellcheck: false,
    },
  });
  window.on("closed", () => { window = null; });
  await window.loadURL(`app://${GAME_HOST}/index.html`);
});
