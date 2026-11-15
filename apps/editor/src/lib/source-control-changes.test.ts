import { describe, expect, it } from "vitest";
import { commitPaths, conflictChoices, groupChanges, groupConflicts, type ChangeLookup } from "./source-control-changes";

const BLOB_A = "a".repeat(64);
const BLOB_B = "b".repeat(64);
const BLOB_SHARED = "c".repeat(64);
const BLOB_LOOSE = "d".repeat(64);
const BLOB_GONE = "e".repeat(64);
const blob = (name: string) => `assets/.blobs/${name}`;

const ASSETS: Record<string, { name: string; type: string; blobs: string[] }> = {
  "assets/Levels/Forest.scene.hasset": { name: "Forest", type: "Scene", blobs: [BLOB_A, BLOB_SHARED] },
  "assets/Textures/Rock.texture.hasset": { name: "Rock Albedo", type: "Texture", blobs: [BLOB_B, BLOB_SHARED] },
  "assets/Hero.class.hasset": { name: "Hero", type: "Class", blobs: [] },
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
    // A blob no changed asset uses goes with any commit; a deleted one never does.
    expect(grouped.loose).toEqual([blob(BLOB_LOOSE)]);
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
      blob(BLOB_LOOSE),
      "assets/Textures/Rock.texture.hasset",
    ].sort());
  });

  it("commits only the loose blobs when no row is chosen", () => {
    expect(commitPaths(grouped, new Set(), lookup)).toEqual([blob(BLOB_LOOSE)]);
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
