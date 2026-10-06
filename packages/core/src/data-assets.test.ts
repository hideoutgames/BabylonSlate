import { describe, expect, it } from "vitest";
import { createDataDefinitionAsset, createDataTreeAsset, createDataTreeEntry, normalizeDataDefinitionAsset, normalizeDataTreeAsset } from "./data-assets";

describe("Definition and tree payloads", () => {
  it("owns detached values, hierarchy and schema snapshots inside the tree", () => {
    const entry = createDataTreeEntry({ name: "Sword", id: "sword", parentId: "weapons", definitionGuid: "stats",
      values: { Health: 12, RemovedField: { label: "keep me" } }, schema: [{ id: "health", name: "Health", typeId: "int" }],
    });
    const source = createDataTreeAsset(null, [createDataTreeEntry({ name: "Weapons", id: "weapons", definitionGuid: null }), entry]);
    const opened = normalizeDataTreeAsset(source);
    expect(opened.entries).toEqual(source.entries);
    (opened.entries[1]!.values.RemovedField as { label: string }).label = "edited";
    opened.entries[1]!.schema![0]!.name = "Other";
    expect(source.entries[1]!.values.RemovedField).toEqual({ label: "keep me" });
    expect(entry.schema![0]!.name).toBe("Health");
    expect(createDataTreeEntry({ name: "Inherited" })).not.toHaveProperty("definitionGuid");
    expect(opened.entries[0]!.definitionGuid).toBeNull();
  });

  it("preserves definition defaults, constraints, stable fields and nested collection metadata", () => {
    const definition = createDataDefinitionAsset([{ id: "values", name: "Values", typeId: "struct", typeClassId: "stats", container: "map",
      keyTypeId: "struct", keyTypeClassId: "key", keyFields: [{ name: "Icon", typeId: "asset", typeClassId: "Texture" }],
      fields: [{ name: "Tags", typeId: "tag", container: "array" }], defaultValue: [], category: "Combat", description: "Per Item", required: true,
    }]);
    const opened = normalizeDataDefinitionAsset(definition);
    expect(opened).toEqual(definition);
    opened.fields[0]!.defaultValue = [{ key: "changed", value: 7 }];
    expect(definition.fields[0]!.defaultValue).toEqual([]);
  });

  it("refuses historical sheets and objects without silently discarding their data", () => {
    const referenceSheet = { kind: "dataSheet", structureGuid: "stats", objectGuids: ["sword", "shield"] };
    const ownedSheet = { kind: "dataSheet", definitionGuid: "stats", rows: [{ id: "sword", name: "Sword", values: { Health: 12 } }] };
    const object = { kind: "dataObject", structureGuid: "stats", values: { Health: 10 } };
    for (const previous of [referenceSheet, ownedSheet, object, { rows: ownedSheet.rows }]) expect(() => normalizeDataTreeAsset(previous)).toThrow();
    expect(referenceSheet.objectGuids).toEqual(["sword", "shield"]);
    expect(ownedSheet.rows[0]!.values).toEqual({ Health: 12 });
    expect(() => normalizeDataDefinitionAsset(object)).toThrow();
    expect(() => normalizeDataTreeAsset({ kind: "dataTree", defaultDefinitionGuid: null, entries: [{ id: "broken", parentId: null, name: "Broken", values: null }] })).toThrow();
  });
});
