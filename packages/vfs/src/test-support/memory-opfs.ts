/** Filesystem boundary double: separate adapters share durable bytes through this root. */
export function createMemoryOpfsRoot(name = ""): FileSystemDirectoryHandle {
  const entries = new Map<string, FileSystemDirectoryHandle | FileSystemFileHandle>();
  const missing = () => new DOMException("Entry not found", "NotFoundError");
  const validate = (entry: string) => {
    if (!entry || entry === "." || entry === ".." || /[/\\]/.test(entry)) throw new TypeError("Invalid entry name");
  };
  return {
    kind: "directory", name,
    async getDirectoryHandle(entry: string, options?: { create?: boolean }) {
      validate(entry);
      let child = entries.get(entry);
      if (!child && options?.create) {
        child = createMemoryOpfsRoot(entry);
        entries.set(entry, child);
      }
      if (!child) throw missing();
      if (child.kind !== "directory") throw new DOMException("Not a directory", "TypeMismatchError");
      return child;
    },
    async getFileHandle(entry: string, options?: { create?: boolean }) {
      validate(entry);
      let child = entries.get(entry);
      if (!child && options?.create) {
        let bytes = new Uint8Array();
        let revision = 0;
        child = {
          kind: "file", name: entry,
          async getFile() {
            const snapshot = bytes.slice();
            return { name: entry, size: snapshot.length, lastModified: revision,
              arrayBuffer: async () => snapshot.buffer,
              slice: (start?: number, end?: number) => ({ arrayBuffer: async () => snapshot.slice(start, end).buffer }) as Blob,
            } as File;
          },
          async createWritable() {
            let next = new Uint8Array();
            return {
              async write(value: ArrayBuffer | Uint8Array) { next = new Uint8Array(value instanceof Uint8Array ? value : value.slice(0)); },
              async close() { bytes = next.slice(); revision++; },
              async abort() {},
            } as unknown as FileSystemWritableFileStream;
          },
        } as FileSystemFileHandle;
        entries.set(entry, child);
      }
      if (!child) throw missing();
      if (child.kind !== "file") throw new DOMException("Not a file", "TypeMismatchError");
      return child;
    },
    async removeEntry(entry: string) {
      validate(entry);
      if (!entries.delete(entry)) throw missing();
    },
    async *entries() { yield* entries; },
  } as unknown as FileSystemDirectoryHandle;
}
