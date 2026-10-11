import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  createEmptyProjectFiles,
  encodeProjectZip,
  writeProjectTree,
} from "./babproject";
import { listTemplateCatalog, loadTemplateFiles } from "./templates";

async function templatesFolder() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Templates");
  return storage;
}

describe("template discovery", () => {
  it("lists template cards without opening archives and reads only the selected template", async () => {
    const storage = await templatesFolder();
    for (const name of ["Selected", "Unused"]) {
      await storage.writeBinary(`${name}.zip`, encodeProjectZip([
        ...createEmptyProjectFiles({ guid: name, name }),
        { path: "assets/source.bin", data: new Uint8Array(128 * 1024) },
      ]));
    }
    const reads = vi.spyOn(storage, "readBinary");
    expect(await listTemplateCatalog(storage)).toEqual([
      { id: "Selected.zip", name: "Selected" }, { id: "Unused.zip", name: "Unused" },
    ]);
    expect(reads).not.toHaveBeenCalled();
    expect((await loadTemplateFiles(storage, "Selected.zip")).some((file) => file.path === "project.json")).toBe(true);
    expect(reads.mock.calls.map(([path]) => path)).toEqual(["Selected.zip"]);
  });

  it("finds directory-backed templates and loads their files without the folder prefix", async () => {
    const storage = await templatesFolder();
    const files = createEmptyProjectFiles({ guid: "g1", name: "Platformer" });
    await writeProjectTree(
      storage,
      files.map((f) => ({ path: `Platformer/${f.path}`, data: f.data })),
    );

    expect(await listTemplateCatalog(storage)).toEqual([{ id: "Platformer", name: "Platformer" }]);
    expect((await loadTemplateFiles(storage, "Platformer")).map((f) => f.path)).toContain("project.json");
  });

  it("ignores folders without a project manifest and non-zip files, and sorts by name", async () => {
    const storage = await templatesFolder();
    await storage.mkdir("Broken", true);
    await storage.writeText("Broken/readme.txt", "no manifest");
    await storage.writeText("notes.txt", "ignored");
    for (const name of ["Zebra", "Alpha"]) {
      const files = createEmptyProjectFiles({ guid: name, name });
      await writeProjectTree(
        storage,
        files.map((f) => ({ path: `${name}/${f.path}`, data: f.data })),
      );
    }

    expect((await listTemplateCatalog(storage)).map((t) => t.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("refuses to load an archive without a project manifest", async () => {
    const storage = await templatesFolder();
    await storage.writeBinary("empty.zip", encodeProjectZip([]));

    await expect(loadTemplateFiles(storage, "empty.zip")).rejects.toThrow("missing project.json");
  });

  it("returns no templates when the folder is unreadable", async () => {
    const storage = new MemoryStorageAdapter("documents");
    expect(await listTemplateCatalog(storage)).toEqual([]);
  });
});
