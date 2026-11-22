export interface MemoryOpfsOptions {
  /** Called for every `getDirectoryHandle` and `getFileHandle`, to count walks. */
  onLookup?: (kind: "directory" | "file", name: string) => void;
  /** Leave `createWritable` out of file handles, as WebKit workers without it do. */
  withoutWritable?: boolean;
  /** Give file handles `createSyncAccessHandle` and `move`, as worker contexts have. */
  syncAccess?: boolean;
}

interface DirectoryNode {
  kind: "directory";
  removed: boolean;
  entries: Map<string, DirectoryNode | FileNode>;
  handle: FileSystemDirectoryHandle;
}

interface FileNode {
  kind: "file";
  removed: boolean;
  bytes: Uint8Array;
  revision: number;
  /** A SyncAccessHandle is open on the file. */
  locked: boolean;
  parent: DirectoryNode;
  name: string;
  handle: FileSystemFileHandle;
}

/**
 * Filesystem boundary double: separate adapters share durable bytes through this root.
 * A removed entry's handles fail with NotFoundError, as OPFS handles of a removed entry do.
 */
export function createMemoryOpfsRoot(name = "", options: MemoryOpfsOptions = {}): FileSystemDirectoryHandle {
  const nodes = new WeakMap<object, DirectoryNode>();
  const missing = () => new DOMException("Entry not found", "NotFoundError");
  const validate = (entry: string) => {
    if (!entry || entry === "." || entry === ".." || /[/\\]/.test(entry)) throw new TypeError("Invalid entry name");
  };
  const markRemoved = (node: DirectoryNode | FileNode) => {
    node.removed = true;
    if (node.kind === "directory") for (const child of node.entries.values()) markRemoved(child);
  };

  function createFile(parent: DirectoryNode, fileName: string): FileNode {
    const node = { kind: "file", removed: false, bytes: new Uint8Array(), revision: 0, locked: false, parent, name: fileName } as FileNode;
    const alive = () => { if (node.removed) throw missing(); };
    const handle: Record<string, unknown> = {
      kind: "file",
      get name() { return node.name; },
      async getFile() {
        alive();
        const snapshot = node.bytes.slice();
        return { name: node.name, size: snapshot.length, lastModified: node.revision,
          arrayBuffer: async () => snapshot.buffer,
          slice: (start?: number, end?: number) => ({ arrayBuffer: async () => snapshot.slice(start, end).buffer }) as Blob,
        } as File;
      },
    };
    if (!options.withoutWritable) {
      handle.createWritable = async () => {
        alive();
        let next = new Uint8Array();
        return {
          async write(value: ArrayBuffer | Uint8Array) { next = new Uint8Array(value instanceof Uint8Array ? value : value.slice(0)); },
          async close() { node.bytes = next.slice(); node.revision++; },
          async abort() {},
        } as unknown as FileSystemWritableFileStream;
      };
    }
    if (options.syncAccess) {
      handle.createSyncAccessHandle = async () => {
        alive();
        if (node.locked) throw new DOMException("Access handle already open", "NoModificationAllowedError");
        node.locked = true;
        let open = true;
        const usable = () => { if (!open) throw new DOMException("Access handle closed", "InvalidStateError"); };
        return {
          write(buffer: Uint8Array, at: { at?: number } = {}) {
            usable();
            const offset = at.at ?? 0;
            if (offset + buffer.byteLength > node.bytes.byteLength) {
              const grown = new Uint8Array(offset + buffer.byteLength);
              grown.set(node.bytes);
              node.bytes = grown;
            }
            node.bytes.set(buffer, offset);
            return buffer.byteLength;
          },
          flush() { usable(); node.revision++; },
          close() { open = false; node.locked = false; },
        };
      };
      handle.move = async (destination: FileSystemDirectoryHandle, newName: string) => {
        alive();
        validate(newName);
        const target = nodes.get(destination);
        if (!target || target.removed) throw missing();
        const existing = target.entries.get(newName);
        if (existing?.kind === "directory") throw new DOMException("A directory has that name", "InvalidModificationError");
        if (existing === node) return;
        if (existing) markRemoved(existing);
        node.parent.entries.delete(node.name);
        target.entries.set(newName, node);
        node.parent = target;
        node.name = newName;
      };
    }
    node.handle = handle as unknown as FileSystemFileHandle;
    return node;
  }

  function createDirectory(directoryName: string): DirectoryNode {
    const node = { kind: "directory", removed: false, entries: new Map() } as DirectoryNode;
    const alive = () => { if (node.removed) throw missing(); };
    node.handle = {
      kind: "directory", name: directoryName,
      async getDirectoryHandle(entry: string, lookup?: { create?: boolean }) {
        options.onLookup?.("directory", entry);
        alive();
        validate(entry);
        let child = node.entries.get(entry);
        if (!child && lookup?.create) {
          child = createDirectory(entry);
          node.entries.set(entry, child);
        }
        if (!child) throw missing();
        if (child.kind !== "directory") throw new DOMException("Not a directory", "TypeMismatchError");
        return child.handle;
      },
      async getFileHandle(entry: string, lookup?: { create?: boolean }) {
        options.onLookup?.("file", entry);
        alive();
        validate(entry);
        let child = node.entries.get(entry);
        if (!child && lookup?.create) {
          child = createFile(node, entry);
          node.entries.set(entry, child);
        }
        if (!child) throw missing();
        if (child.kind !== "file") throw new DOMException("Not a file", "TypeMismatchError");
        return child.handle;
      },
      async removeEntry(entry: string) {
        alive();
        validate(entry);
        const child = node.entries.get(entry);
        if (!child) throw missing();
        if (child.kind === "file" && child.locked) throw new DOMException("Access handle open", "NoModificationAllowedError");
        node.entries.delete(entry);
        markRemoved(child);
      },
      async *entries() {
        alive();
        for (const [entry, child] of node.entries) yield [entry, child.handle];
      },
    } as unknown as FileSystemDirectoryHandle;
    nodes.set(node.handle, node);
    return node;
  }

  return createDirectory(name).handle;
}

/** The folder an OPFS adapter keeps a project or library id in: `project-v2-<SHA-256 hex of the JSON-encoded id>`. */
export async function opfsProjectFolder(root: FileSystemDirectoryHandle, id: string): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle(await opfsDirectoryName(id));
}

/** The OPFS folder name of a project or library id. */
export async function opfsDirectoryName(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(id)));
  return `project-v2-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
