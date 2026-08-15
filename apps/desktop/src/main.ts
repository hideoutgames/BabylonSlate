import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
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
  ipcMain.handle("settings:write", async (_event, json: string) => {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, json);
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
  ipcMain.handle("project:openDocuments", async (_event, name: string) => {
    return storage.openDocumentsProject(name);
  });
  ipcMain.handle(
    "project:openKnown",
    async (_event, handle: ProjectFolderHandle) => {
      if (handle.id.startsWith("node:")) {
        return storage.openAbsoluteFolder(
          handle.id.slice("node:".length),
          handle.name,
          handle.tier,
        );
      }
      return storage.openKnownFolder(handle);
    },
  );
  ipcMain.handle("project:list", async () => storage.listProjects());
  ipcMain.handle("project:current", async () => storage.getCurrentFolder());
  ipcMain.handle("project:release", async () => storage.releaseFolder());
  ipcMain.handle("project:readBinary", async (_event, path: string) => {
    const bytes = await storage.readBinary(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });
  ipcMain.handle(
    "project:writeBinary",
    async (_event, path: string, data: ArrayBuffer) => {
      await storage.writeBinary(path, new Uint8Array(data));
    },
  );
  ipcMain.handle("project:exists", async (_event, path: string) =>
    storage.exists(path),
  );
  ipcMain.handle("project:readdir", async (_event, path: string) =>
    storage.readdir(path),
  );
  ipcMain.handle(
    "project:mkdir",
    async (_event, path: string, recursive?: boolean) =>
      storage.mkdir(path, recursive),
  );
  ipcMain.handle("project:remove", async (_event, path: string) =>
    storage.remove(path),
  );
  ipcMain.handle("project:stat", async (_event, path: string) =>
    storage.stat(path),
  );
}

void app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
