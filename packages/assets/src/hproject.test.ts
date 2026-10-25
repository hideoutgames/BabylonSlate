import { describe, expect, it, vi } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { createDefaultScene, createEmptyProject, normalizeProjectSettings, SCENE_SCHEMA_VERSION } from "@haptic/core";
import { readGoldenBinary, writeGoldenBinary } from "@haptic/test-kit";
import { decodeAssetDocument, encodeAssetDocument } from "./asset-document";
import {
  createProjectFromTemplate,
  decodeProjectZip,
  encodeProjectZip,
  exportProjectZip,
  readProjectTree,
  rewriteProjectIdentity,
  writeProjectTree,
} from "./hproject";
import { bytesEqual } from "./test-support/bytes";
import { createEmptyProjectFiles } from "./test-support/project-files";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

describe("hproject codec", () => {
  it("round-trips directory ↔ zip byte-identically for sorted trees", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Demo.hproject");
    // Pinned so the golden bytes do not change with each engine release.
    const engineVersion = "0.0.0";
    const files = createEmptyProjectFiles({
      guid: "proj-1",
      name: "Demo",
      engineVersion,
    });
    files.push({
      path: "assets/readme.txt",
      data: new TextEncoder().encode("hello"),
    });
    // The golden carries a real asset so the container covers the shape the
    // editor actually writes, not just manifests.
    files.push({
      path: "assets/main.scene.hasset",
      data: await encodeAssetDocument({
        type: "Scene",
        name: "main.scene",
        guid: "00000000-0000-4000-8000-00000000scene".slice(0, 36),
        version: SCENE_SCHEMA_VERSION,
        payload: { ...createDefaultScene("2d") },
      }, { engineVersion }),
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

    const relative = "__fixtures__/demo.hproject.zip";
    if (UPDATE) {
      writeGoldenBinary(FIXTURE_DIR, relative, zip);
    }
    const golden = readGoldenBinary(FIXTURE_DIR, relative);
    expect(bytesEqual(zip, golden)).toBe(true);

    const sceneFromGolden = decodeProjectZip(golden).find(
      (f) => f.path === "assets/main.scene.hasset",
    );
    expect(await decodeAssetDocument(sceneFromGolden!.data)).toMatchObject({
      version: SCENE_SCHEMA_VERSION,
      payload: createDefaultScene("2d"),
    });
  });

  it("preserves requested renderer axes and shading in an exported project snapshot", async () => {
    const source = new MemoryStorageAdapter();
    await source.openDocumentsProject("Rendering.hproject");
    await writeProjectTree(
      source,
      createEmptyProjectFiles({ guid: "rendering", name: "Rendering" }),
    );
    const snapshot = createEmptyProject("Rendering", {
      render: { renderPath: "clusteredForward", gpuBackend: "webgpu", mode: "cel" },
    });
    const manifest = decodeProjectZip(await exportProjectZip(source, snapshot)).find(
      (file) => file.path === "project.json",
    )!;
    const reopened = JSON.parse(new TextDecoder().decode(manifest.data));
    expect(normalizeProjectSettings(reopened.settings).render).toMatchObject({
      renderPath: "clusteredForward",
      gpuBackend: "webgpu",
      mode: "cel",
    });
  });

  it("rejects a full backup when a subtree cannot be listed", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.openDocumentsProject("Backup");
    await writeProjectTree(storage, createEmptyProjectFiles({ guid: "backup", name: "Backup" }));
    await storage.writeText("assets/source.txt", "must be included");
    const readdir = storage.readdir.bind(storage);
    vi.spyOn(storage, "readdir").mockImplementation(async (path) => {
      if (path === "assets") throw new Error("Provider is offline");
      return readdir(path);
    });
    await expect(exportProjectZip(storage)).rejects.toThrow("Provider is offline");
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
    await dest.openDocumentsProject("FromTemplate.hproject");
    await createProjectFromTemplate({
      templateFiles: template,
      destination: dest,
      guid: "new-guid",
      name: "FromTemplate.hproject",
    });
    const tree = await readProjectTree(dest);
    const manifest = JSON.parse(
      new TextDecoder().decode(
        tree.find((f) => f.path === "project.json")!.data,
      ),
    ) as { guid: string; name: string };
    expect(manifest.guid).toBe("new-guid");
    expect(manifest.name).toBe("FromTemplate.hproject");
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
