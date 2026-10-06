import { describe, expect, it } from "vitest";
import { createDataTreeAsset, createDataTreeEntry, type DataTreeEntry } from "./data-assets";
import { buildDataTreeIndex } from "./data-tree-index";

describe("Data Tree hierarchy", () => {
  it("indexes exact paths, sibling order and nearest schema overrides independently of storage parent order", () => {
    const tree = createDataTreeAsset("default", [
      createDataTreeEntry({ id: "sword", parentId: "weapons", name: "Sword", values: { Damage: 4 } }),
      createDataTreeEntry({ id: "weapons", name: "Weapons", definitionGuid: "weapon", values: { Damage: 99 } }),
      createDataTreeEntry({ id: "shield", parentId: "weapons", name: "Shield" }),
      createDataTreeEntry({ id: "group", name: "Grouping", definitionGuid: null }),
      createDataTreeEntry({ id: "nested", parentId: "group", name: "Nested" }),
      createDataTreeEntry({ id: "typed", parentId: "nested", name: "Sword", definitionGuid: "item" }),
      createDataTreeEntry({ id: "default", name: "Default" }),
    ]);
    const { index, issues } = buildDataTreeIndex(tree);
    expect(issues).toEqual([]);
    expect(index!.orderedEntries.map((entry) => entry.id)).toEqual(["weapons", "sword", "shield", "group", "nested", "typed", "default"]);
    expect(index!.childrenByParentId.get("weapons")!.map((entry) => entry.id)).toEqual(["sword", "shield"]);
    expect(index!.pathById.get("typed")).toBe("Grouping/Nested/Sword");
    expect(index!.idByPath.get("Weapons/Sword")).toBe("sword");
    for (const invalid of ["", "/Weapons/Sword", "Weapons/Sword/", "weapons/sword", "Sword", "sword"]) expect(index!.idByPath.has(invalid)).toBe(false);
    expect([...index!.effectiveDefinitionById]).toEqual([
      ["weapons", "weapon"], ["sword", "weapon"], ["shield", "weapon"], ["group", null], ["nested", null], ["typed", "item"], ["default", "default"],
    ]);
    expect(index!.byId.get("sword")!.values).toEqual({ Damage: 4 });
  });

  it("reindexes renamed and moved subtrees without changing identities, own values or former path strings", () => {
    const tree = createDataTreeAsset("first", [
      createDataTreeEntry({ id: "branch", name: "Branch" }),
      createDataTreeEntry({ id: "leaf", parentId: "branch", name: "Leaf", values: { Authored: 9 } }),
      createDataTreeEntry({ id: "other", name: "Other", definitionGuid: "second" }),
    ]);
    const before = buildDataTreeIndex(tree).index!;
    tree.entries[0]!.name = "Renamed";
    tree.entries[0]!.parentId = "other";
    const after = buildDataTreeIndex(tree).index!;
    expect(before.pathById.get("leaf")).toBe("Branch/Leaf");
    expect(after.pathById.get("leaf")).toBe("Other/Renamed/Leaf");
    expect(after.idByPath.has("Branch/Leaf")).toBe(false);
    expect(after.effectiveDefinitionById.get("leaf")).toBe("second");
    expect(after.byId.get("leaf")).toMatchObject({ id: "leaf", parentId: "branch", values: { Authored: 9 } });
  });

  it.each([
    ["duplicate identity", [{ id: "a", name: "One" }, { id: "a", name: "Two" }], "duplicate-entry"],
    ["ambiguous sibling name", [{ id: "a", name: "Sword" }, { id: "b", name: "sword" }], "duplicate-entry-name"],
    ["missing parent", [{ id: "a", name: "One", parentId: "missing" }], "missing-parent"],
    ["self parent", [{ id: "a", name: "One", parentId: "a" }], "cyclic-tree"],
    ["disconnected cycle", [{ id: "a", name: "One", parentId: "b" }, { id: "b", name: "Two", parentId: "a" }], "cyclic-tree"],
  ] as const)("rejects %s atomically", (_label, options, code) => {
    const tree = createDataTreeAsset(null, options.map((entry) => createDataTreeEntry(entry)));
    const previous = structuredClone(tree);
    const result = buildDataTreeIndex(tree);
    expect(result.index).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code, severity: "error" }));
    expect(tree).toEqual(previous);
  });

  it.each(["", " Name", "Name ", "Parent/Child", ".", "..", "Line\nBreak", "Control\u007f"])("rejects ambiguous path segment %j", (name) => {
    const result = buildDataTreeIndex(createDataTreeAsset(null, [createDataTreeEntry({ name })]));
    expect(result.index).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid-entry-name" }));
  });

  it("supports the depth limit and rejects deeper trees without recursive traversal", () => {
    const entries: DataTreeEntry[] = Array.from({ length: 129 }, (_, index) => createDataTreeEntry({
      id: String(index), parentId: index === 0 ? null : String(index - 1), name: `Level ${index}`,
    }));
    expect(buildDataTreeIndex(createDataTreeAsset(null, entries.slice(0, 128))).index!.orderedEntries).toHaveLength(128);
    const result = buildDataTreeIndex(createDataTreeAsset(null, entries));
    expect(result.index).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "tree-depth", entryId: "128" }));
  });
});
