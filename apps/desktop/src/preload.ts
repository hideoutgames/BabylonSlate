import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("haptic", {
  userData: {
    readSettings: () => ipcRenderer.invoke("settings:read"),
    writeSettings: (json: string) => ipcRenderer.invoke("settings:write", json),
  },
  saveGames: {
    read: (key: string) => ipcRenderer.invoke("save-games:read", key),
    write: (key: string, text: string) => ipcRenderer.invoke("save-games:write", key, text),
    remove: (key: string) => ipcRenderer.invoke("save-games:remove", key),
    list: (prefix: string) => ipcRenderer.invoke("save-games:list", prefix),
    acquireLock: (key: string) => ipcRenderer.invoke("save-games:acquire-lock", key),
    releaseLock: (token: string) => ipcRenderer.invoke("save-games:release-lock", token),
  },
  secrets: {
    get: (key: string) => ipcRenderer.invoke("secrets:get", key),
    set: (key: string, value: string) =>
      ipcRenderer.invoke("secrets:set", key, value),
    delete: (key: string) => ipcRenderer.invoke("secrets:delete", key),
  },
  accountSecrets: {
    get: (key: string) => ipcRenderer.invoke("account-secrets:get", key),
    set: (key: string, value: string) =>
      ipcRenderer.invoke("account-secrets:set", key, value),
    delete: (key: string) => ipcRenderer.invoke("account-secrets:delete", key),
  },
  http: {
    fetch: (request: unknown) => ipcRenderer.invoke("lfs:fetch", request),
  },
  project: {
    pickProjectFolder: () => ipcRenderer.invoke("project:pickFolder"),
    openDocumentsProject: (name: string) =>
      ipcRenderer.invoke("project:openDocuments", name),
    openKnownFolder: (handle: unknown) =>
      ipcRenderer.invoke("project:openKnown", handle),
    listProjects: () => ipcRenderer.invoke("project:list"),
    releaseFolder: () => ipcRenderer.invoke("project:release"),
    readBinary: (path: string) => ipcRenderer.invoke("project:readBinary", path),
    readBinaryRange: (path: string, offset: number, length: number, revision?: string) =>
      ipcRenderer.invoke("project:readBinaryRange", path, offset, length, revision),
    writeBinary: (path: string, data: ArrayBuffer) =>
      ipcRenderer.invoke("project:writeBinary", path, data),
    exists: (path: string) => ipcRenderer.invoke("project:exists", path),
    readdir: (path: string) => ipcRenderer.invoke("project:readdir", path),
    mkdir: (path: string, recursive?: boolean) =>
      ipcRenderer.invoke("project:mkdir", path, recursive),
    remove: (path: string) => ipcRenderer.invoke("project:remove", path),
    stat: (path: string) => ipcRenderer.invoke("project:stat", path),
  },
  // App-owned user libraries; main accepts only its allowlisted scopes.
  library: {
    readBinary: (scope: string, path: string) => ipcRenderer.invoke("library:readBinary", scope, path),
    readBinaryRange: (scope: string, path: string, offset: number, length: number, revision?: string) =>
      ipcRenderer.invoke("library:readBinaryRange", scope, path, offset, length, revision),
    writeBinary: (scope: string, path: string, data: ArrayBuffer) =>
      ipcRenderer.invoke("library:writeBinary", scope, path, data),
    exists: (scope: string, path: string) => ipcRenderer.invoke("library:exists", scope, path),
    readdir: (scope: string, path: string) => ipcRenderer.invoke("library:readdir", scope, path),
    mkdir: (scope: string, path: string, recursive?: boolean) =>
      ipcRenderer.invoke("library:mkdir", scope, path, recursive),
    remove: (scope: string, path: string) => ipcRenderer.invoke("library:remove", scope, path),
    stat: (scope: string, path: string) => ipcRenderer.invoke("library:stat", scope, path),
  },
});
