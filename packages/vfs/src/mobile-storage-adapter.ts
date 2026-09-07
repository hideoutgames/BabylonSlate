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
  private initialized: Promise<void> | undefined;

  constructor(documents?: DocumentsStorageAdapter) {
    this.documents = documents ?? new DocumentsStorageAdapter();
  }

  init(): Promise<void> {
    return this.initialized ??= this.external.init().then(() => {
      if (this.external.getCurrentFolder()) this.active = "external";
    });
  }

  private port(): ProjectStorage {
    return this.active === "external" ? this.external : this.documents;
  }

  async pickProjectFolder(): Promise<ProjectFolderHandle> {
    await this.init();
    const handle = await this.external.pickProjectFolder();
    this.active = "external";
    return handle;
  }

  async openDocumentsProject(name: string): Promise<ProjectFolderHandle> {
    await this.init();
    const handle = await this.documents.openDocumentsProject(name);
    this.active = "documents";
    return handle;
  }

  async openKnownFolder(
    handle: ProjectFolderHandle,
  ): Promise<ProjectFolderHandle> {
    await this.init();
    if (handle.tier === "external") {
      try {
        const opened = await this.external.openKnownFolder(handle);
        this.active = "external";
        return opened;
      } catch (error) {
        if (await this.external.needsReconnect()) this.active = "external";
        throw error;
      }
    }
    const opened = await this.documents.openKnownFolder(handle);
    this.active = "documents";
    return opened;
  }

  async listProjects(): Promise<ProjectFolderHandle[]> {
    await this.init();
    const docs = await this.documents.listProjects();
    const ext = await this.external.listProjects();
    return [...docs, ...ext];
  }

  getCurrentFolder(): ProjectFolderHandle | null {
    return this.port().getCurrentFolder();
  }

  async releaseFolder(): Promise<void> {
    await this.init();
    await this.port().releaseFolder();
  }

  async needsReconnect(): Promise<boolean> {
    await this.init();
    if (this.active !== "external") return false;
    return (await this.external.needsReconnect?.()) ?? false;
  }

  async reconnectFolder(validate?: (candidate: ProjectStorage) => Promise<void>): Promise<ProjectFolderHandle> {
    await this.init();
    const handle = await this.external.reconnectFolder(validate);
    this.active = "external";
    return handle;
  }

  async readText(path: string): Promise<string> {
    await this.init();
    return this.port().readText(path);
  }

  async writeText(path: string, data: string): Promise<void> {
    await this.init();
    return this.port().writeText(path, data);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    await this.init();
    return this.port().readBinary(path);
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.init();
    return this.port().writeBinary(path, data);
  }

  async exists(path: string): Promise<boolean> {
    await this.init();
    return this.port().exists(path);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    await this.init();
    return this.port().readdir(path);
  }

  async mkdir(path: string, recursive?: boolean): Promise<void> {
    await this.init();
    return this.port().mkdir(path, recursive);
  }

  async remove(path: string): Promise<void> {
    await this.init();
    return this.port().remove(path);
  }

  async stat(path: string): Promise<FileStat> {
    await this.init();
    return this.port().stat(path);
  }
}
