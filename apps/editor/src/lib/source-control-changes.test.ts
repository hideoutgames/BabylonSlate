import { describe, expect, it, vi } from "vitest";
import { AssetRegistry, createVfsBlobStore, encodeHasset, projectContentRoot, readHassetHeader } from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { testAsset } from "../testing/diff-assets";
import { assetBlobFolder, commitPaths, conflictChoices, groupChanges, groupConflicts, registryChangeLookup, withUnindexedAssets, type ChangeLookup } from "./source-control-changes";

const BLOB_A = "a".repeat(64);
const BLOB_B = "b".repeat(64);
const BLOB_SHARED = "c".repeat(64);
const BLOB_LOOSE = "d".repeat(64);
const BLOB_GONE = "e".repeat(64);
const blob = (name: string) => `assets/.blobs/${name}`;

const ASSETS: Record<string, { name: string; type: string; blobPaths: string[] }> = {
  "assets/Levels/Forest.scene.hasset": { name: "Forest", type: "Scene", blobPaths: [blob(BLOB_A), blob(BLOB_SHARED)] },
  "assets/Textures/Rock.texture.hasset": { name: "Rock Albedo", type: "Texture", blobPaths: [blob(BLOB_B), blob(BLOB_SHARED)] },
  "assets/Hero.class.hasset": { name: "Hero", type: "Class", blobPaths: [] },
};
const lookup: ChangeLookup = (path) => ASSETS[path] ?? null;

describe("groupChanges", () => {
  it("lists assets and other files as rows, each asset carrying its changed blobs, and never a blob alone", () => {
    const grouped = groupChanges([
      { path: blob(BLOB_A), kind: "added" },
      { path: blob(BLOB_B), kind: "added" },
      { path: blob(BLOB_SHARED), kind: "added" },
      { path: blob(BLOB_LOOSE), kind: "added" },
      { path: blob(BLOB_GONE), kind: "deleted" },
      { path: "assets/Hero.class.hasset", kind: "deleted" },
      { path: "assets/Levels/.haptic-folder", kind: "added" },
      { path: "assets/Levels/Forest.scene.hasset", kind: "modified" },
      { path: "assets/Old/Fence.prefab.hasset", kind: "deleted" },
      { path: "assets/Textures/Rock.texture.hasset", kind: "modified" },
      { path: "project.json", kind: "modified" },
    ], lookup);
    expect(grouped.rows.map((row) => [row.name, row.folder, row.kind, row.type, row.paths])).toEqual([
      ["Hero", "Assets", "deleted", "Class", ["assets/Hero.class.hasset"]],
      ["Levels", "Assets", "added", "Folder", ["assets/Levels/.haptic-folder"]],
      ["Forest", "Levels", "modified", "Scene", ["assets/Levels/Forest.scene.hasset", blob(BLOB_A), blob(BLOB_SHARED)]],
      // Not indexed (deleted from disk): named after its file.
      ["Fence", "Old", "deleted", null, ["assets/Old/Fence.prefab.hasset"]],
      ["Rock Albedo", "Textures", "modified", "Texture", ["assets/Textures/Rock.texture.hasset", blob(BLOB_B)]],
      ["Project Settings", "Project", "modified", "Project", ["project.json"]],
    ]);
  });
});

describe("commitPaths", () => {
  const grouped = groupChanges([
    { path: blob(BLOB_A), kind: "added" },
    { path: blob(BLOB_B), kind: "added" },
    { path: blob(BLOB_SHARED), kind: "added" },
    { path: blob(BLOB_LOOSE), kind: "added" },
    { path: "assets/Levels/Forest.scene.hasset", kind: "modified" },
    { path: "assets/Textures/Rock.texture.hasset", kind: "modified" },
  ], lookup);

  it("commits a chosen asset with every changed blob it uses, including one another row lists", () => {
    // Rock alone: its own blob and the shared one Forest's row lists, never Forest itself.
    expect(commitPaths(grouped, new Set(["assets/Textures/Rock.texture.hasset"]), lookup)).toEqual([
      blob(BLOB_B),
      blob(BLOB_SHARED),
      "assets/Textures/Rock.texture.hasset",
    ].sort());
  });

  it("never commits a changed blob no chosen asset uses, such as one a reverted edit left", () => {
    expect(commitPaths(grouped, new Set(), lookup)).toEqual([]);
    expect(commitPaths(grouped, new Set(["assets/Levels/Forest.scene.hasset"]), lookup)).not.toContain(blob(BLOB_LOOSE));
  });
});

describe("blobs in more than one content root", () => {
  /** Above the inline limit, so the chunk is stored as a blob of its root. */
  const PAYLOAD = new Uint8Array(70 * 1024).map((_, index) => index % 251);

  /** A Texture imported into the project, then copied into a plugin before either is committed. */
  async function textureCopiedIntoPlugin() {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Game");
    const projectBlobs = createVfsBlobStore(storage, "assets/.blobs");
    const bytes = await encodeHasset({
      header: {
        dependencyMetadataVersion: 1, requiredDependencies: [], requiredVariableNames: [],
        guid: "rock", type: "Texture", name: "Rock", engineVersion: "0.0.0",
        version: 1, mode: "thin", dependencies: [], parentClass: null, payload: {},
      },
      chunks: [{ id: "payload", kind: "payload", mime: "application/octet-stream", data: PAYLOAD }],
      writeBlob: (sha256, data) => projectBlobs.writeBlob(sha256, data),
    });
    await storage.mkdir("assets", true);
    await storage.writeBinary("assets/Rock.texture.hasset", bytes);
    const locator = readHassetHeader(bytes).chunks[0]!.locator;
    if (!("blob" in locator)) throw new Error("The fixture chunk was stored inline");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    await registry.mountRoot({ id: "plugin:props", kind: "plugin", pathPrefix: "plugins/Props/assets" });
    const copy = await registry.duplicateAsset("rock", "plugin:props");
    expect(copy.path).toBe("plugins/Props/assets/Rock.texture.hasset");
    // Each root keeps its own blob store, so the same blob is now in two folders.
    const sha = locator.blob;
    expect(await storage.exists(`plugins/Props/assets/.blobs/${sha}`)).toBe(true);
    return { registry, sha };
  }

  it("gives each asset the blob in its own root's folder, so committing one asset commits the blob it loads", async () => {
    const { registry, sha } = await textureCopiedIntoPlugin();
    const lookup = registryChangeLookup(registry);
    const grouped = groupChanges([
      { path: `assets/.blobs/${sha}`, kind: "added" },
      { path: "assets/Rock.texture.hasset", kind: "added" },
      { path: `plugins/Props/assets/.blobs/${sha}`, kind: "added" },
      { path: "plugins/Props/assets/Rock.texture.hasset", kind: "added" },
    ], lookup);
    expect(grouped.rows.map((row) => row.paths)).toEqual([
      ["assets/Rock.texture.hasset", `assets/.blobs/${sha}`],
      ["plugins/Props/assets/Rock.texture.hasset", `plugins/Props/assets/.blobs/${sha}`],
    ]);
    expect(commitPaths(grouped, new Set(["assets/Rock.texture.hasset"]), lookup)).toEqual([
      `assets/.blobs/${sha}`,
      "assets/Rock.texture.hasset",
    ]);
  });

  it("asks once per asset in a pull conflict, each with the blob in its own root's folder", async () => {
    const { registry, sha } = await textureCopiedIntoPlugin();
    const rows = groupConflicts([
      { path: `assets/.blobs/${sha}`, mine: "added", theirs: "added" },
      { path: "assets/Rock.texture.hasset", mine: "added", theirs: "added" },
      { path: `plugins/Props/assets/.blobs/${sha}`, mine: "added", theirs: "added" },
      { path: "plugins/Props/assets/Rock.texture.hasset", mine: "added", theirs: "added" },
    ], registryChangeLookup(registry));
    expect(rows.map((row) => row.paths)).toEqual([
      ["assets/Rock.texture.hasset", `assets/.blobs/${sha}`],
      ["plugins/Props/assets/Rock.texture.hasset", `plugins/Props/assets/.blobs/${sha}`],
    ]);
  });
});

describe("withUnindexedAssets", () => {
  it("reads the header of a chosen changed asset the registry does not index, so its blobs go with it", async () => {
    // A disabled plugin's asset: no content root is mounted for it.
    const path = "plugins/Props/assets/Crate.texture.hasset";
    const stored = await testAsset("Texture", "Crate", { chunks: [{ id: "payload", kind: "payload", mime: "application/octet-stream", data: new Uint8Array(70 * 1024).fill(7) }] });
    const sha = [...stored.blobs.keys()][0]!;
    const changes = [
      { path: `plugins/Props/assets/.blobs/${sha}`, kind: "added" as const },
      { path: blob(BLOB_LOOSE), kind: "added" as const },
      { path, kind: "added" as const },
    ];
    const read = vi.fn(async () => stored.bytes);
    const known = await withUnindexedAssets(lookup, changes, new Set([path]), read);
    expect(known(path)).toEqual({ name: "Crate", type: "Texture", blobPaths: [`plugins/Props/assets/.blobs/${sha}`] });
    expect(commitPaths(groupChanges(changes, known), new Set([path]), known)).toEqual([`plugins/Props/assets/.blobs/${sha}`, path]);
    // Only chosen assets are read; indexed ones keep the registry's answer.
    expect(read).toHaveBeenCalledTimes(1);
    expect(await withUnindexedAssets(lookup, changes, new Set(), read)).toBe(lookup);
  });
});

describe("assetBlobFolder", () => {
  it.each([
    ["assets/Levels/Forest.scene.hasset", "assets/.blobs"],
    ["plugins/Props/assets/Crate.texture.hasset", "plugins/Props/assets/.blobs"],
    ["extensions/Rain/assets/Rain.material.hasset", "extensions/Rain/assets/.blobs"],
    ["project.json", null],
  ])("puts %s's blobs in %s", (path, folder) => {
    expect(assetBlobFolder(path)).toBe(folder);
  });
});

describe("groupConflicts", () => {
  it("asks once per asset and applies the choice to each of its files, listing an unclaimed file on its own", () => {
    const rows = groupConflicts([
      { path: blob(BLOB_A), mine: "added", theirs: "added" },
      { path: "assets/Levels/Forest.scene.hasset", mine: "modified", theirs: "modified" },
      { path: "assets/Hero.class.hasset", mine: "modified", theirs: "deleted" },
      { path: blob(BLOB_LOOSE), mine: "added", theirs: "added" },
    ], lookup);
    expect(rows.map((row) => [row.name, row.mine, row.theirs, row.paths])).toEqual([
      ["Forest", "modified", "modified", ["assets/Levels/Forest.scene.hasset", blob(BLOB_A)]],
      ["Hero", "modified", "deleted", ["assets/Hero.class.hasset"]],
      [BLOB_LOOSE, "added", "added", [blob(BLOB_LOOSE)]],
    ]);
    expect(conflictChoices(rows, new Map([["assets/Levels/Forest.scene.hasset", "theirs"], ["assets/Hero.class.hasset", "mine"]]))).toEqual({
      "assets/Levels/Forest.scene.hasset": "theirs",
      [blob(BLOB_A)]: "theirs",
      "assets/Hero.class.hasset": "mine",
    });
  });
});
