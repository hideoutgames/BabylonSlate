import type { DocumentsFilesystemApi } from "../documents-adapter";

export type FakeDocumentsFs = DocumentsFilesystemApi & {
  tree: Map<string, { kind: "file" | "dir"; data?: Uint8Array }>;
};

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

/**
 * In-process stand-in for Capacitor Filesystem so Documents-tier logic is
 * testable. Like the native plugin, any `encoding` means text (an unknown name
 * falls back to UTF-8) and only an omitted one means base64-encoded bytes.
 */
export function createFakeDocumentsFs(): FakeDocumentsFs {
  const tree = new Map<string, { kind: "file" | "dir"; data?: Uint8Array }>();
  tree.set("BabylonSlate/projects", { kind: "dir" });

  let revision = 0;
  const revisions = new Map<string, string>();
  const normalize = (path: string) => path.replace(/\/+$/, "") || "";
  const missing = () => Object.assign(new Error("missing"), { code: "OS-PLUG-FILE-0008" });

  const ensureParents = (path: string) => {
    const parts = normalize(path).split("/");
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i]!;
      if (!tree.has(cur)) tree.set(cur, { kind: "dir" });
    }
  };

  return {
    tree,
    async mkdir({ path, recursive }) {
      const p = normalize(path);
      if (recursive) ensureParents(p);
      tree.set(p, { kind: "dir" });
    },
    async readdir({ path }) {
      const p = normalize(path);
      const prefix = p ? `${p}/` : "";
      const files = [...tree.entries()]
        .filter(([key]) => {
          if (!key.startsWith(prefix) || key === p) return false;
          const rest = key.slice(prefix.length);
          return !rest.includes("/");
        })
        .map(([key, node]) => ({
          name: key.slice(prefix.length),
          type: node.kind === "dir" ? "directory" : "file",
          size: node.data?.byteLength ?? 0,
          mtime: 1,
        }));
      if (!tree.has(p) && p !== "") {
        throw missing();
      }
      return { files };
    },
    async readFile({ path, encoding }) {
      const node = tree.get(normalize(path));
      if (!node || node.kind !== "file") throw missing();
      const bytes = node.data ?? new Uint8Array();
      return { data: encoding ? new TextDecoder().decode(bytes) : toBase64(bytes) };
    },
    async readFileRange({ path, offset, length, expectedRevision }) {
      const key = normalize(path);
      const node = tree.get(key);
      if (!node || node.kind !== "file") throw missing();
      const currentRevision = revisions.get(key) ?? "0";
      if (expectedRevision !== undefined && expectedRevision !== currentRevision) throw new Error("Source revision changed");
      const bytes = node.data ?? new Uint8Array();
      if (offset + length > bytes.length) throw new RangeError("Range exceeds file size");
      return { data: toBase64(bytes.subarray(offset, offset + length)), totalSize: bytes.length, revision: currentRevision, actualBytesRead: length };
    },
    async writeFile({ path, data, encoding }) {
      const p = normalize(path);
      ensureParents(p);
      const bytes = encoding ? new TextEncoder().encode(data) : Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      tree.set(p, { kind: "file", data: bytes });
      revisions.set(p, String(++revision));
      return {};
    },
    async deleteFile({ path }) {
      if (!tree.delete(normalize(path))) throw missing();
    },
    async rmdir({ path }) {
      const p = normalize(path);
      for (const key of [...tree.keys()]) {
        if (key === p || key.startsWith(`${p}/`)) tree.delete(key);
      }
    },
    async stat({ path }) {
      const node = tree.get(normalize(path));
      if (!node) throw missing();
      return {
        type: node.kind === "dir" ? "directory" : "file",
        size: node.data?.byteLength ?? 0,
        mtime: 1,
      };
    },
  };
}
