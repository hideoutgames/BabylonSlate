import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { app, BrowserWindow, dialog, ipcMain, net, safeStorage } from "electron";
import { NodeStorageAdapter } from "@babylonslate/vfs/node";
import type { ProjectFolderHandle } from "@babylonslate/core";

const rootDir = dirname(fileURLToPath(import.meta.url));

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
    },
  });
  const editorIndex = join(rootDir, "../../editor/dist/index.html");
  await window.loadFile(editorIndex);
}

function registerIpc(): void {
  const projectsRoot = join(app.getPath("userData"), "projects");
  const storage = new NodeStorageAdapter(projectsRoot);
  const settingsPath = userDataFile("engine-settings.json");

  ipcMain.handle("settings:read", async () => {
    try {
      return await readFile(settingsPath, "utf8");
    } catch {
      return null;
    }
  });
  ipcMain.handle("settings:write", async (_event, json) => {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, String(json));
  });

  const secretsPath = userDataFile("source-control-secrets.json");

  async function readSecretMap(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(secretsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      return {};
    } catch {
      return {};
    }
  }

  async function writeSecretMap(map: Record<string, string>): Promise<void> {
    await mkdir(dirname(secretsPath), { recursive: true });
    await writeFile(secretsPath, JSON.stringify(map));
  }

  ipcMain.handle("secrets:get", async (_event, key) => {
    const map = await readSecretMap();
    const packed = map[String(key)];
    if (!packed) return null;
    if (!safeStorage.isEncryptionAvailable()) return packed;
    return safeStorage.decryptString(Buffer.from(packed, "base64"));
  });
  ipcMain.handle("secrets:set", async (_event, key, value) => {
    const map = await readSecretMap();
    map[String(key)] = safeStorage.isEncryptionAvailable()
      ? Buffer.from(safeStorage.encryptString(String(value))).toString("base64")
      : String(value);
    await writeSecretMap(map);
  });
  ipcMain.handle("secrets:delete", async (_event, key) => {
    const map = await readSecretMap();
    delete map[String(key)];
    await writeSecretMap(map);
  });

  ipcMain.handle("lfs:fetch", async (_event, request) => {
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
    });
    return { status: response.status, bodyText: await response.text() };
  });

  ipcMain.handle("project:pickFolder", async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      throw new Error("Folder picker cancelled");
    }
    return storage.openAbsoluteFolder(picked.filePaths[0]);
  });
  ipcMain.handle("project:openDocuments", async (_event, name) => {
    return storage.openDocumentsProject(String(name));
  });
  ipcMain.handle("project:openKnown", async (_event, handle) => {
    const folder = handle as ProjectFolderHandle;
    if (folder.id.startsWith("node:")) {
      return storage.openAbsoluteFolder(
        folder.id.slice("node:".length),
        folder.name,
        folder.tier,
      );
    }
    return storage.openKnownFolder(folder);
  });
  ipcMain.handle("project:list", async () => storage.listProjects());
  ipcMain.handle("project:current", async () => storage.getCurrentFolder());
  ipcMain.handle("project:release", async () => storage.releaseFolder());
  ipcMain.handle("project:readBinary", async (_event, path) => {
    const bytes = await storage.readBinary(String(path));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });
  ipcMain.handle("project:writeBinary", async (_event, path, data) => {
    await storage.writeBinary(String(path), new Uint8Array(data as ArrayBuffer));
  });
  ipcMain.handle("project:exists", async (_event, path) =>
    storage.exists(String(path)),
  );
  ipcMain.handle("project:readdir", async (_event, path) =>
    storage.readdir(String(path)),
  );
  ipcMain.handle("project:mkdir", async (_event, path, recursive) =>
    storage.mkdir(String(path), recursive !== false),
  );
  ipcMain.handle("project:remove", async (_event, path) =>
    storage.remove(String(path)),
  );
  ipcMain.handle("project:stat", async (_event, path) =>
    storage.stat(String(path)),
  );
}

void app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
