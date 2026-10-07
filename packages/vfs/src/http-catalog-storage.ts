import type { DirEntry, FileStat, ProjectFolderHandle, ProjectStorage, StorageRangeRead, StorageReadOptions } from "@babylonslate/core";
import { StorageNotFoundError } from "@babylonslate/core";
import { projectRelativePath } from "./project-path";
import { checkStorageRevision, rethrowStorageReadFailure, StorageReadCounter, validateStorageRange } from "./storage-range";

export interface HttpStoragePart {
  offset: number;
  length: number;
  /** Relative content-addressed file, independently readable on ordinary static hosts. */
  file: string;
  sha256: string;
}
export interface HttpStorageFile {
  path: string;
  size: number;
  revision: string;
  parts: HttpStoragePart[];
}
export interface HttpStorageCatalog { version: 1; files: HttpStorageFile[] }

/** Read-only virtual files whose payload segments are fetched only on demand. */
export class HttpCatalogStorageAdapter implements ProjectStorage {
  readonly hasStrongSourceRevisions: boolean = true;
  private readonly files = new Map<string, HttpStorageFile>();
  private readonly directories = new Set([""]);
  private readonly reads = new StorageReadCounter();
  private readonly handle: ProjectFolderHandle;
  private readonly options: { baseUrl: string; fetch: typeof fetch; name?: string; catalogBytesRead?: number };
  private active = true;

  constructor(catalog: HttpStorageCatalog, options: { baseUrl: string; fetch: typeof fetch; name?: string; catalogBytesRead?: number }) {
    this.options = options;
    if (catalog.version !== 1 || !Array.isArray(catalog.files)) throw new Error("Unsupported static storage catalog");
    this.handle = { id: `http-catalog:${options.baseUrl}`, name: options.name ?? "static-content", tier: "opfs" };
    for (const file of catalog.files) {
      const path = projectRelativePath(file.path);
      if (this.files.has(path) || typeof file.revision !== "string" || !file.revision) throw new Error(`Invalid catalog entry: ${path}`);
      validateStorageRange(0, file.size);
      let next = 0;
      const parts: HttpStoragePart[] = [];
      for (const part of file.parts) {
        validateStorageRange(part.offset, part.length, file.size);
        if (part.offset !== next || part.length === 0 || !/^[a-f0-9]{64}$/.test(part.sha256)) throw new Error(`Invalid catalog segments: ${path}`);
        parts.push({ ...part, file: projectRelativePath(part.file) });
        next += part.length;
      }
      if (next !== file.size) throw new Error(`Incomplete catalog file: ${path}`);
      this.files.set(path, { ...file, parts });
      const segments = path.split("/");
      for (let end = 1; end < segments.length; end++) this.directories.add(segments.slice(0, end).join("/"));
    }
    for (const path of this.files.keys()) if (this.directories.has(path)) throw new Error(`Catalog file/directory collision: ${path}`);
    if (options.catalogBytesRead) this.reads.record("full", options.catalogBytesRead);
  }

  private path(path: string): string {
    if (!this.active) throw new Error("No project folder selected");
    return projectRelativePath(path === "." ? "" : path, true);
  }
  private file(path: string): HttpStorageFile {
    const file = this.files.get(this.path(path));
    if (!file) throw new StorageNotFoundError(path);
    return file;
  }
  getReadMetrics() { return this.reads.snapshot(); }
  getCurrentFolder() { return this.active ? this.handle : null; }
  async releaseFolder() { this.active = false; }
  async listProjects() { return [this.handle]; }
  async openKnownFolder(handle: ProjectFolderHandle) {
    if (handle.id !== this.handle.id) throw new Error("Unknown static storage root");
    this.active = true;
    return this.handle;
  }
  async pickProjectFolder(): Promise<ProjectFolderHandle> { throw new Error("Storage is read-only"); }
  async openDocumentsProject(): Promise<ProjectFolderHandle> { throw new Error("Storage is read-only"); }
  async writeText(): Promise<void> { throw new Error("Storage is read-only"); }
  async writeBinary(): Promise<void> { throw new Error("Storage is read-only"); }
  async mkdir(): Promise<void> { throw new Error("Storage is read-only"); }
  async remove(): Promise<void> { throw new Error("Storage is read-only"); }

  async exists(path: string) { const cleaned = this.path(path); return this.files.has(cleaned) || this.directories.has(cleaned); }
  async stat(path: string): Promise<FileStat> {
    const cleaned = this.path(path);
    if (this.directories.has(cleaned)) return { isDir: true, size: null, mtime: null };
    const file = this.file(cleaned);
    return { isDir: false, size: file.size, mtime: null };
  }
  async readdir(path: string): Promise<DirEntry[]> {
    const cleaned = this.path(path);
    if (!this.directories.has(cleaned)) throw new StorageNotFoundError(path, { message: `Directory not found: ${path}` });
    const prefix = cleaned ? `${cleaned}/` : "";
    const entries: DirEntry[] = [];
    for (const directory of this.directories) {
      if (directory && directory.startsWith(prefix) && !directory.slice(prefix.length).includes("/")) entries.push({ name: directory.slice(prefix.length), isDir: true });
    }
    for (const [filePath, file] of this.files) {
      if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) entries.push({ name: filePath.slice(prefix.length), isDir: false, size: file.size });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  async readText(path: string, options?: StorageReadOptions) { return new TextDecoder().decode(await this.readBinary(path, options)); }
  async readBinary(path: string, options?: StorageReadOptions) {
    const file = this.file(path);
    const result = await this.read(file, 0, file.size, "full", options?.signal);
    return result.bytes;
  }
  async readBinaryRange(path: string, offset: number, length: number, revision?: string, options?: StorageReadOptions) {
    validateStorageRange(offset, length);
    const file = this.file(path);
    checkStorageRevision(path, file.revision, revision);
    return this.read(file, offset, length, "range", options?.signal);
  }

  private async read(file: HttpStorageFile, offset: number, length: number, kind: "full" | "range", signal?: AbortSignal): Promise<StorageRangeRead> {
    validateStorageRange(offset, length, file.size);
    let actualBytesRead = 0;
    try {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(length);
      for (const part of file.parts) {
        signal?.throwIfAborted();
        const start = Math.max(offset, part.offset), end = Math.min(offset + length, part.offset + part.length);
        if (end <= start) continue;
        const partStart = start - part.offset, expected = end - start;
        const partial = partStart !== 0 || expected !== part.length;
        const base = this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`;
        const url = `${base}${part.file.split("/").map(encodeURIComponent).join("/")}`;
        // Native Window.fetch rejects an arbitrary options object as its receiver.
        const fetchContent = this.options.fetch;
        const init = partial ? { headers: { Range: `bytes=${partStart}-${partStart + expected - 1}` } } : undefined;
        const response = await fetchContent(url, signal ? { ...init, signal } : init);
        const contentRange = response.headers.get("content-range");
        const encoding = response.headers.get("content-encoding");
        if ((partial && (response.status !== 206 || contentRange !== `bytes ${partStart}-${partStart + expected - 1}/${part.length}` || (encoding && encoding !== "identity"))) ||
            (!partial && response.status !== 200)) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error(`Invalid bounded HTTP response for ${file.path}: ${response.status}`);
        }
        const declared = response.headers.get("content-length");
        // Fetch exposes decoded bodies; compressed full-object Content-Length
        // describes transfer bytes. Bounded streaming and hashes validate the
        // decoded object. Ranges above require identity encoding.
        if (declared !== null && (!encoding || encoding === "identity") && (!/^\d+$/.test(declared) || Number(declared) !== expected)) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP byte length mismatch: ${file.path}`);
        }
        const partBytes = bytes.subarray(start - offset, end - offset);
        try { await readBoundedBody(response, partBytes, signal); }
        catch (error) {
          actualBytesRead += (error as { actualBytesRead?: number }).actualBytesRead ?? 0;
          throw error;
        }
        actualBytesRead += partBytes.byteLength;
        if (!partial) {
          const digest = await crypto.subtle.digest("SHA-256", partBytes);
          const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
          if (hash !== part.sha256) throw new Error(`HTTP content hash mismatch: ${file.path}`);
        }
      }
      signal?.throwIfAborted();
      return { bytes, totalSize: file.size, revision: file.revision, actualBytesRead };
    } catch (error) {
      // An abort reason is shared by concurrent reads. Give this operation its
      // own byte count instead of mutating another request's cancellation error.
      const failure = signal?.aborted && error === signal.reason
        ? Object.assign(new Error("Storage read cancelled", { cause: error }), { name: "AbortError" }) : error;
      rethrowStorageReadFailure(failure, actualBytesRead);
    } finally { this.reads.record(kind, length, actualBytesRead); }
  }
}

async function readBoundedBody(response: Response, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing HTTP response body");
  let actualBytesRead = 0;
  // Cancel closes the readable stream immediately, including a pending read.
  // Its underlying cancel hook may itself be asynchronous; do not retain our
  // destination buffer while waiting for that unrelated cleanup promise.
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { signal?.throwIfAborted(); break; }
      const position = actualBytesRead;
      actualBytesRead += value.byteLength;
      if (actualBytesRead > bytes.byteLength) throw new Error("HTTP response exceeded its requested byte length");
      signal?.throwIfAborted();
      bytes.set(value, position);
    }
    if (actualBytesRead !== bytes.byteLength) throw new Error("Truncated HTTP response");
  } catch (error) {
    cancel();
    const failure = signal?.aborted && error === signal.reason
      ? Object.assign(new Error("Storage read cancelled", { cause: error }), { name: "AbortError" }) : error;
    rethrowStorageReadFailure(failure, actualBytesRead);
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
