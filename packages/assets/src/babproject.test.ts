import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  createEmptyProjectFiles,
  decodeProjectZip,
  encodeProjectZip,
  exportProjectZip,
  importProjectZip,
  readProjectTree,
  writeProjectTree,
} from "./babproject";
import { bytesEqual } from "./bytes";
import {
  hasJournal,
  truncateJournal,
  writeJournalStub,
} from "./derived-data";

describe("babproject codec", () => {
  it("round-trips directory ↔ zip byte-identically for sorted trees", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Demo.babproject");
    const files = createEmptyProjectFiles({
      guid: "proj-1",
      name: "Demo",
    });
    files.push({
      path: "assets/readme.txt",
      data: new TextEncoder().encode("hello"),
    });
    await writeProjectTree(storage, files);

    const fromDir = await readProjectTree(storage);
    const zip = encodeProjectZip(fromDir);
    const fromZip = decodeProjectZip(zip);
    expect(fromZip.map((f) => f.path)).toEqual(fromDir.map((f) => f.path));
    for (let i = 0; i < fromDir.length; i++) {
      expect(bytesEqual(fromDir[i]!.data, fromZip[i]!.data)).toBe(true);
    }

    // Second encode of the same tree is byte-identical.
    expect(bytesEqual(zip, encodeProjectZip(fromZip))).toBe(true);
  });

  it("exports and re-imports through ProjectStorage", async () => {
    const a = new MemoryStorageAdapter();
    await a.openDocumentsProject("A.babproject");
    await writeProjectTree(
      a,
      createEmptyProjectFiles({ guid: "g", name: "A" }),
    );
    const zip = await exportProjectZip(a);

    const b = new MemoryStorageAdapter();
    await b.openDocumentsProject("B.babproject");
    await importProjectZip(b, zip);
    const tree = await readProjectTree(b);
    expect(tree.some((f) => f.path === "project.json")).toBe(true);
  });

  it("parameterises manifest kind for plugins", () => {
    const files = createEmptyProjectFiles({
      kind: "plugin",
      guid: "plug-1",
      name: "MyPlugin",
    });
    expect(files.some((f) => f.path === "plugin.json")).toBe(true);
    expect(files.some((f) => f.path === "layout.json")).toBe(false);
  });
});

describe("derived data", () => {
  it("stores journals outside the project tree contract", async () => {
    const derived = new MemoryStorageAdapter();
    await derived.openDocumentsProject("derived-root");
    await writeJournalStub(derived, "proj-guid", ["cmd-1"]);
    expect(await hasJournal(derived, "proj-guid")).toBe(true);
    await truncateJournal(derived, "proj-guid");
    expect(await hasJournal(derived, "proj-guid")).toBe(false);
  });
});
