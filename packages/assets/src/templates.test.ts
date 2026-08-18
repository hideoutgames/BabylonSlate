import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  createEmptyProjectFiles,
  encodeProjectZip,
  writeProjectTree,
} from "./babproject";
import { listTemplates } from "./templates";

async function templatesFolder() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Templates");
  return storage;
}

describe("template discovery", () => {
  it("finds directory-backed templates", async () => {
    const storage = await templatesFolder();
    const files = createEmptyProjectFiles({ guid: "g1", name: "Platformer" });
    await writeProjectTree(
      storage,
      files.map((f) => ({ path: `Platformer/${f.path}`, data: f.data })),
    );

    const templates = await listTemplates(storage);
    expect(templates).toHaveLength(1);
    expect(templates[0]!.id).toBe("Platformer");
    expect(templates[0]!.name).toBe("Platformer");
    expect(templates[0]!.files.map((f) => f.path)).toContain("project.json");
  });

  it("finds zip-backed templates", async () => {
    const storage = await templatesFolder();
    const zip = encodeProjectZip(
      createEmptyProjectFiles({ guid: "g2", name: "TopDown" }),
    );
    await storage.writeBinary("TopDown.zip", zip);

    const templates = await listTemplates(storage);
    expect(templates.map((t) => t.name)).toEqual(["TopDown"]);
    expect(templates[0]!.id).toBe("TopDown.zip");
    expect(templates[0]!.files.map((f) => f.path)).toContain("project.json");
  });

  it("still finds legacy .babproject directory and zip templates", async () => {
    const storage = await templatesFolder();
    const dirFiles = createEmptyProjectFiles({ guid: "legacy-dir", name: "LegacyDir" });
    await writeProjectTree(
      storage,
      dirFiles.map((f) => ({
        path: `LegacyDir.babproject/${f.path}`,
        data: f.data,
      })),
    );
    await storage.writeBinary(
      "LegacyZip.babproject",
      encodeProjectZip(
        createEmptyProjectFiles({ guid: "legacy-zip", name: "LegacyZip" }),
      ),
    );

    const templates = await listTemplates(storage);
    expect(templates.map((t) => t.name)).toEqual(["LegacyDir", "LegacyZip"]);
  });

  it("ignores entries without a project manifest and sorts by name", async () => {
    const storage = await templatesFolder();
    await storage.mkdir("Broken", true);
    await storage.writeText("Broken/readme.txt", "no manifest");
    await storage.writeText("notes.txt", "ignored");
    await storage.writeBinary("empty.zip", encodeProjectZip([]));
    for (const name of ["Zebra", "Alpha"]) {
      const files = createEmptyProjectFiles({ guid: name, name });
      await writeProjectTree(
        storage,
        files.map((f) => ({ path: `${name}/${f.path}`, data: f.data })),
      );
    }

    const templates = await listTemplates(storage);
    expect(templates.map((t) => t.name)).toEqual(["Alpha", "Zebra"]);
  });

  it("returns no templates when the folder is unreadable", async () => {
    const storage = new MemoryStorageAdapter("documents");
    expect(await listTemplates(storage)).toEqual([]);
  });
});
