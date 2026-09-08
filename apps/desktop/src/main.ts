import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
  type IpcMainInvokeEvent,
} from "electron";
import { NodeStorageAdapter } from "@babylonslate/vfs/node";
import type { ProjectFolderHandle } from "@babylonslate/core";
import { DesktopSecretStore } from "./desktop-secret-store";
import { isEditorSender, rendererFile, validateIpcArguments } from "./packaged-security";

const rootDir = join(app.getAppPath(), "host");
const rendererRoot = join(app.getAppPath(), "renderer");
const editorWindows = new Set<number>();
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
  window.on("closed", () => editorWindows.delete(contentsId));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isEditorSender(url, true)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  await window.loadURL("app://babylonslate/index.html");
}

function registerIpc(): void {
  const projectsRoot = join(app.getPath("userData"), "projects");
  const storage = new NodeStorageAdapter(projectsRoot);
  const settingsPath = userDataFile("engine-settings.json");
  const grantsPath = userDataFile("project-folder-grants.json");
  async function grantedFolders(): Promise<string[]> {
    try { return JSON.parse(await readFile(grantsPath, "utf8")) as string[]; }
    catch { return []; }
  }

  handle("settings:read", async () => {
    try {
      return await readFile(settingsPath, "utf8");
    } catch {
      return null;
    }
  });
  handle("settings:write", async (_event, json) => {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, String(json));
  });

  const secretsPath = userDataFile("source-control-secrets.json");
  const secrets = new DesktopSecretStore(
    {
      read: () => readFile(secretsPath, "utf8"),
      write: async (contents) => {
        await mkdir(dirname(secretsPath), { recursive: true });
        await writeFile(secretsPath, contents);
      },
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

  handle("lfs:fetch", async (_event, request) => {
    const req = request as {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    const url = String(req.url ?? "");
    const response = await net.fetch(url, {
      method: req.method ?? "GET",
      headers: req.headers ?? {},
      body: req.body,
      redirect: "error",
    });
    return { status: response.status, bodyText: await response.text() };
  });

  handle("project:pickFolder", async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      throw new Error("Folder picker cancelled");
    }
    const selected = await realpath(picked.filePaths[0]);
    const grants = new Set(await grantedFolders());
    grants.add(selected);
    await mkdir(dirname(grantsPath), { recursive: true });
    await writeFile(grantsPath, JSON.stringify([...grants]));
    return storage.openAbsoluteFolder(selected);
  });
  handle("project:openDocuments", async (_event, name) => {
    return storage.openDocumentsProject(String(name));
  });
  handle("project:openKnown", async (_event, handle) => {
    const folder = handle as ProjectFolderHandle;
    if (folder.id.startsWith("node:")) {
      const known = await storage.listProjects();
      const target = await realpath(folder.id.slice("node:".length));
      if (!known.some(item => item.id === folder.id) && !(await grantedFolders()).includes(target)) throw new Error("Choose this folder using the folder picker first");
      return storage.openAbsoluteFolder(
        target,
        folder.name,
        folder.tier,
      );
    }
    return storage.openKnownFolder(folder);
  });
  handle("project:list", async () => storage.listProjects());
  handle("project:current", async () => storage.getCurrentFolder());
  handle("project:release", async () => storage.releaseFolder());
  handle("project:readBinary", async (_event, path) => {
    const bytes = await storage.readBinary(String(path));
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  });
  handle("project:writeBinary", async (_event, path, data) => {
    await storage.writeBinary(
      String(path),
      new Uint8Array(data as ArrayBuffer),
    );
  });
  handle("project:exists", async (_event, path) =>
    storage.exists(String(path)),
  );
  handle("project:readdir", async (_event, path) =>
    storage.readdir(String(path)),
  );
  handle("project:mkdir", async (_event, path, recursive) =>
    storage.mkdir(String(path), recursive !== false),
  );
  handle("project:remove", async (_event, path) =>
    storage.remove(String(path)),
  );
  handle("project:stat", async (_event, path) =>
    storage.stat(String(path)),
  );
}

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle("app", async request => {
    try {
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
  registerIpc();
  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
