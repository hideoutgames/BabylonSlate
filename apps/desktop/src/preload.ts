import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("babylonslate", {
  userData: {
    readSettings: () => ipcRenderer.invoke("settings:read"),
    writeSettings: (json: string) => ipcRenderer.invoke("settings:write", json),
  },
  secrets: {
    get: (key: string) => ipcRenderer.invoke("secrets:get", key),
    set: (key: string, value: string) =>
      ipcRenderer.invoke("secrets:set", key, value),
    delete: (key: string) => ipcRenderer.invoke("secrets:delete", key),
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
    getCurrentFolder: () => ipcRenderer.invoke("project:current"),
    releaseFolder: () => ipcRenderer.invoke("project:release"),
    readBinary: (path: string) => ipcRenderer.invoke("project:readBinary", path),
    writeBinary: (path: string, data: ArrayBuffer) =>
      ipcRenderer.invoke("project:writeBinary", path, data),
    exists: (path: string) => ipcRenderer.invoke("project:exists", path),
    readdir: (path: string) => ipcRenderer.invoke("project:readdir", path),
    mkdir: (path: string, recursive?: boolean) =>
      ipcRenderer.invoke("project:mkdir", path, recursive),
    remove: (path: string) => ipcRenderer.invoke("project:remove", path),
    stat: (path: string) => ipcRenderer.invoke("project:stat", path),
  },
});
