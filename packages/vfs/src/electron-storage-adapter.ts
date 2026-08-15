import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import {
  getElectronProjectBridge,
  type ElectronProjectBridge,
} from "./platform";

function toBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

/**
 * Renderer-side ProjectStorage over the Electron preload IPC bridge.
 * The main process backs this with `NodeStorageAdapter`.
 */
export class ElectronStorageAdapter implements ProjectStorage {
  private folder: ProjectFolderHandle | null = null;
  private readonly bridge: ElectronProjectBridge | null;

  constructor(bridge: ElectronProjectBridge | null = getElectronProjectBridge()) {
    this.bridge = bridge;
  }

  private requireBridge(): ElectronProjectBridge {
    if (!this.bridge) {
      throw new Error("Electron project bridge is not installed");
    }
    return this.bridge;
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    const handle = await this.requireBridge().pickProjectFolder();
    this.folder = handle;
    return handle;
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    const handle = await this.requireBridge().openDocumentsProject(name);
    this.folder = handle;
    return handle;
  }

  async openKnownFolder(handle: ProjectFolderHandle): Promise<ProjectFolderHandle> {
    const next = await this.requireBridge().openKnownFolder(handle);
    this.folder = next;
    return next;
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    return this.requireBridge().listProjects();
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.folder;
  }

  async releaseFolder(): Promise<void> {
    await this.requireBridge().releaseFolder();
    this.folder = null;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.requireBridge().readBinary(path));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.requireBridge().writeBinary(path, toBuffer(data));
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBinary(path));
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.writeBinary(path, new TextEncoder().encode(data));
  }

  async exists(path: string): Promise<boolean> {
    return this.requireBridge().exists(path);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    return this.requireBridge().readdir(path);
  }

  async mkdir(path: string, recursive = true): Promise<void> {
    await this.requireBridge().mkdir(path, recursive);
  }

  async remove(path: string): Promise<void> {
    await this.requireBridge().remove(path);
  }

  async stat(path: string): Promise<FileStat> {
    return this.requireBridge().stat(path);
  }
}
