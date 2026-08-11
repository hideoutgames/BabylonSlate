import { beforeEach, describe, expect, it } from "vitest";
import type { DocumentsFilesystemApi } from "./documents-adapter";
import { DocumentsStorageAdapter } from "./documents-adapter";

function createFakeFs(): DocumentsFilesystemApi & {
  tree: Map<string, { kind: "file" | "dir"; data?: string }>;
} {
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

describe("DocumentsStorageAdapter", () => {
  let fs: ReturnType<typeof createFakeFs>;
  let storage: DocumentsStorageAdapter;

  beforeEach(() => {
    fs = createFakeFs();
    storage = new DocumentsStorageAdapter(fs);
  });

  it("creates and lists documents projects without a picker", async () => {
    await storage.openDocumentsProject("Demo.babproject");
    await storage.writeText("project.json", '{"ok":true}');
    expect(await storage.readText("project.json")).toBe('{"ok":true}');

    const listed = await storage.listProjects();
    expect(listed).toEqual([
      {
        id: "documents:Demo.babproject",
        name: "Demo.babproject",
        tier: "documents",
      },
    ]);
  });

  it("reopens a known documents folder without prompting", async () => {
    await storage.openDocumentsProject("A.babproject");
    await storage.writeBinary("blob.bin", new Uint8Array([1, 2, 3]));
    await storage.releaseFolder();

    const reopened = new DocumentsStorageAdapter(fs);
    await reopened.openKnownFolder({
      id: "documents:A.babproject",
      name: "A.babproject",
      tier: "documents",
    });
    expect(await reopened.readBinary("blob.bin")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("rejects pickProjectFolder", async () => {
    await expect(storage.pickProjectFolder()).rejects.toThrow(/no picker/i);
  });
});
