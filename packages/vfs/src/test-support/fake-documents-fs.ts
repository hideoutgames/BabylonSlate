import type { DocumentsFilesystemApi } from "../documents-adapter";

export type FakeDocumentsFs = DocumentsFilesystemApi & {
  tree: Map<string, { kind: "file" | "dir"; data?: string }>;
};

/** In-process stand-in for Capacitor Filesystem so Documents-tier logic is testable. */
export function createFakeDocumentsFs(): FakeDocumentsFs {
  const tree = new Map<string, { kind: "file" | "dir"; data?: string }>();
  tree.set("BabylonSlate/projects", { kind: "dir" });

  const normalize = (path: string) => path.replace(/\/+$/, "") || "";

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
          size: node.data?.length ?? 0,
          mtime: 1,
        }));
      if (!tree.has(p) && p !== "") {
        throw new Error("missing");
      }
      return { files };
    },
    async readFile({ path }) {
      const node = tree.get(normalize(path));
      if (!node || node.kind !== "file") throw new Error("missing");
      return { data: node.data ?? "" };
    },
    async writeFile({ path, data }) {
      const p = normalize(path);
      ensureParents(p);
      tree.set(p, { kind: "file", data });
      return {};
    },
    async deleteFile({ path }) {
      if (!tree.delete(normalize(path))) throw new Error("missing");
    },
    async rmdir({ path }) {
      const p = normalize(path);
      for (const key of [...tree.keys()]) {
        if (key === p || key.startsWith(`${p}/`)) tree.delete(key);
      }
    },
    async stat({ path }) {
      const node = tree.get(normalize(path));
      if (!node) throw new Error("missing");
      return {
        type: node.kind === "dir" ? "directory" : "file",
        size: node.data?.length ?? 0,
        mtime: 1,
      };
    },
  };
}
