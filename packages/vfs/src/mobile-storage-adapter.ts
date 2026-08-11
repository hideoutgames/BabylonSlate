import type {
  DirEntry,
  FileStat,
  ProjectFolderHandle,
  ProjectStorage,
} from "@babylonslate/core";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { ScopedStorageAdapter } from "./scoped-storage-adapter";

/**
 * Composite iPad storage: durable Documents default tier (no picker) plus
 * opt-in external folders (picker + bookmarks + Reconnect).
 */
export class MobileStorageAdapter implements ProjectStorage {
  private readonly documents: DocumentsStorageAdapter;
  private readonly external = new ScopedStorageAdapter();
  private active: "documents" | "external" = "documents";

  constructor(documents?: DocumentsStorageAdapter) {
    this.documents = documents ?? new DocumentsStorageAdapter();
  }

  async init(): Promise<void> {
    await this.external.init();
    if (
      this.external.getCurrentFolder() &&
      !(await this.external.needsReconnect?.())
    ) {
      this.active = "external";
    }
  }

  private port(): ProjectStorage {
    return this.active === "external" ? this.external : this.documents;
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    const handle = await this.external.pickProjectFolder();
    this.active = "external";
    return handle;
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    const handle = await this.documents.openDocumentsProject(name);
    this.active = "documents";
    return handle;
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    if (handle.tier === "external") {
      const opened = await this.external.openKnownFolder(handle);
      this.active = "external";
      return opened;
    }
    const opened = await this.documents.openKnownFolder(handle);
    this.active = "documents";
    return opened;
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    const docs = await this.documents.listProjects();
    const ext = await this.external.listProjects();
    return [...docs, ...ext];
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.port().getCurrentFolder();
  }

  async releaseFolder(): Promise<void> {
    await this.port().releaseFolder();
  }

  async needsReconnect(): Promise<boolean> {
    if (this.active !== "external") return false;
    return (await this.external.needsReconnect?.()) ?? false;
  }

  async reconnectFolder(): Promise<ProjectFolderHandle> {
    const handle = await this.external.reconnectFolder!();
    this.active = "external";
    return handle;
  }

  readText(path: string): Promise<string> {
    return this.port().readText(path);
  }

  writeText(path: string, data: string): Promise<void> {
    return this.port().writeText(path, data);
  }

  readBinary(path: string): Promise<Uint8Array> {
    return this.port().readBinary(path);
  }

  writeBinary(path: string, data: Uint8Array): Promise<void> {
    return this.port().writeBinary(path, data);
  }

  exists(path: string): Promise<boolean> {
    return this.port().exists(path);
  }

  readdir(path: string): Promise<DirEntry[]> {
    return this.port().readdir(path);
  }

  mkdir(path: string, recursive?: boolean): Promise<void> {
    return this.port().mkdir(path, recursive);
  }

  remove(path: string): Promise<void> {
    return this.port().remove(path);
  }

  stat(path: string): Promise<FileStat> {
    return this.port().stat(path);
  }
}
