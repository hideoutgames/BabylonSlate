import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { readGoldenBinary, writeGoldenBinary } from "@babylonslate/test-kit";
import { decodeAssetDocument, encodeAssetDocument } from "./asset-document";
import {
  createEmptyProjectFiles,
  createProjectFromTemplate,
  decodeProjectZip,
  encodeProjectZip,
  exportProjectZip,
  importProjectZip,
  readProjectTree,
  rewriteProjectIdentity,
  writeProjectTree,
} from "./babproject";
import { bytesEqual } from "./bytes";
import {
  hasJournal,
  truncateJournal,
  writeJournalStub,
} from "./derived-data";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

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
    // The golden carries a real asset so the container covers the shape the
    // editor actually writes, not just manifests.
    files.push({
      path: "assets/main.scene.babasset",
      data: await encodeAssetDocument({
        type: "Scene",
        name: "main.scene",
        guid: "00000000-0000-4000-8000-00000000scene".slice(0, 36),
        version: 1,
        payload: { name: "Main", meshes: [] },
      }),
    });
    await writeProjectTree(storage, files);

    const fromDir = await readProjectTree(storage);
    const zip = encodeProjectZip(fromDir);
    const fromZip = decodeProjectZip(zip);
    expect(fromZip.map((f) => f.path)).toEqual(fromDir.map((f) => f.path));
    for (let i = 0; i < fromDir.length; i++) {
      expect(bytesEqual(fromDir[i]!.data, fromZip[i]!.data)).toBe(true);
    }

    expect(bytesEqual(zip, encodeProjectZip(fromZip))).toBe(true);

    const relative = "__fixtures__/demo.babproject.zip";
    if (UPDATE) {
      writeGoldenBinary(FIXTURE_DIR, relative, zip);
    }
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(zip, golden)).toBe(true);

    const sceneFromGolden = decodeProjectZip(golden).find(
      (f) => f.path === "assets/main.scene.babasset",
    );
    expect((await decodeAssetDocument(sceneFromGolden!.data)).payload).toEqual({
      name: "Main",
      meshes: [],
    });
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

  it("creates a project from a template rewriting only name and guid", async () => {
    const template = createEmptyProjectFiles({
      guid: "template-guid",
      name: "Template",
    });
    const dest = new MemoryStorageAdapter("documents");
    await dest.openDocumentsProject("FromTemplate.babproject");
    await createProjectFromTemplate({
      templateFiles: template,
      destination: dest,
      guid: "new-guid",
      name: "FromTemplate.babproject",
    });
    const tree = await readProjectTree(dest);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        tree.find((f) => f.path === "project.json")!.data,
      ),
    ) as { guid: string; name: string };
    expect(manifest.guid).toBe("new-guid");
    expect(manifest.name).toBe("FromTemplate.babproject");
  });

  it("rewriteProjectIdentity leaves non-manifest files intact", () => {
    const files = [
      {
        path: "assets/x.txt",
        data: new TextEncoder().encode("keep"),
      },
      ...createEmptyProjectFiles({ guid: "old", name: "Old" }),
    ];
    const rewritten = rewriteProjectIdentity(files, {
      guid: "new",
      name: "New",
    });
    expect(
      new TextDecoder().decode(
        rewritten.find((f) => f.path === "assets/x.txt")!.data,
      ),
    ).toBe("keep");
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
