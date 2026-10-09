import { describe, expect, it } from "vitest";
import { createDataDefinitionAsset } from "@babylonslate/core";
import { dataTypeSchemas } from "./data-catalog";
import { createDataEntryForDefinition, reconcileDataEntry, resolveDataEntryValues } from "./data-values";
import type { TypeSchemas } from "./type-defaults";

describe("authored data snapshots", () => {
  it("creates and reconciles empty collections without expanding reusable schema paths", () => {
    const definitions = Array.from({ length: 24 }, (_, index) => createDataDefinitionAsset(index === 23 ? [] : [
      { id: "left", name: "Left", typeId: "struct", typeClassId: `definition-${index + 1}`, container: "array" },
      { id: "right", name: "Right", typeId: "struct", typeClassId: `definition-${index + 1}`, container: "map", keyTypeId: "struct", keyTypeClassId: `definition-${index + 1}` },
    ]));
    let schemaReads = 0;
    const dataDefinitions = Object.fromEntries(definitions.map((definition, index) => [`definition-${index}`, {
      name: `Definition ${index}`,
      get fields() {
        // Fail deterministically before an accidental schema expansion can
        // allocate millions of snapshots or depend on a wall-clock timeout.
        if (++schemaReads > definitions.length * 16) throw new Error("Empty collections expanded their reusable schema paths.");
        return definition.fields;
      },
    }]));
    const schemas: TypeSchemas = { enums: {}, structs: dataDefinitions, dataDefinitions };
    const fields = definitions[0]!.fields;
    const created = createDataEntryForDefinition("definition-0", fields, schemas);
    expect(created.values).toEqual({ Left: [], Right: [] });
    expect(JSON.stringify(created.schema).length).toBeLessThan(500);

    fields[0]!.name = "First";
    const reconciled = reconcileDataEntry(created, "definition-0", fields, schemas);
    expect(reconciled.issues).toEqual([]);
    expect(reconciled.entry.values).toEqual({ First: [], Right: [] });
    expect(JSON.stringify(reconciled.entry.schema).length).toBeLessThan(500);
    expect(resolveDataEntryValues(reconciled.entry, "definition-0", schemas)).toEqual({ First: [], Right: new Map() });
    expect(created.values).toEqual({ Left: [], Right: [] });
  });

  it("records populated array and map branches and retains retired reference metadata during renames", () => {
    const leaf = createDataDefinitionAsset([
      { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
      { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Texture" },
    ]);
    const nested = createDataDefinitionAsset([
      { id: "children", name: "Children", typeId: "struct", typeClassId: "leaf", container: "array" },
    ]);
    const root = createDataDefinitionAsset([
      { id: "rows", name: "Rows", typeId: "struct", typeClassId: "nested", container: "array", defaultValue: [
        { Children: [] }, { Children: [{ Icon: "row-icon", Retired: "row-retired" }] },
      ] },
      { id: "lookup", name: "Lookup", typeId: "struct", typeClassId: "nested", container: "map", keyTypeId: "struct", keyTypeClassId: "leaf", defaultValue: [
        { key: { Icon: "key-icon", Retired: "key-retired" }, value: { Children: [{ Icon: "value-icon", Retired: "value-retired" }] } },
      ] },
    ]);
    const dataDefinitions = {
      root: { name: "Root", fields: root.fields },
      nested: { name: "Nested", fields: nested.fields },
      leaf: { name: "Leaf", fields: leaf.fields },
    };
    const schemas: TypeSchemas = { enums: {}, structs: dataDefinitions, dataDefinitions };
    const created = createDataEntryForDefinition("root", root.fields, schemas);
    nested.fields[0]!.name = "Parts";
    leaf.fields = [{ id: "icon", name: "Surface", typeId: "asset", typeClassId: "Texture" }];
    dataDefinitions.leaf.fields = leaf.fields;

    const reconciled = reconcileDataEntry(created, "root", root.fields, schemas);
    expect(reconciled.entry.values).toEqual({
      Rows: [{ Parts: [] }, { Parts: [{ Surface: "row-icon", Retired: "row-retired" }] }],
      Lookup: [{ key: { Surface: "key-icon", Retired: "key-retired" }, value: { Parts: [{ Surface: "value-icon", Retired: "value-retired" }] } }],
    });
    const retired = { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Texture" };
    expect(reconciled.entry.schema?.[0]?.fields?.[0]?.fields).toContainEqual(retired);
    expect(reconciled.entry.schema?.[1]?.fields?.[0]?.fields).toContainEqual(retired);
    expect(reconciled.entry.schema?.[1]?.keyFields).toContainEqual(retired);
    expect(resolveDataEntryValues(reconciled.entry, "root", schemas)).toEqual({
      Rows: [{ Parts: [] }, { Parts: [{ Surface: "row-icon" }] }],
      Lookup: new Map([[{ Surface: "key-icon" }, { Parts: [{ Surface: "value-icon" }] }]]),
    });
  });

  it("copies a Hard Loading policy from catalog Definitions into new entry snapshots, nested fields included", () => {
    const schemas = dataTypeSchemas([
      { guid: "kit", name: "Kit", type: "DataDefinition", payload: { kind: "dataDefinition", fields: [
        { id: "sound", name: "Sound", typeId: "asset", typeClassId: "Audio", loading: "hard" },
        { id: "skin", name: "Skin", typeId: "asset", typeClassId: "Texture" },
      ] } },
      { guid: "weapon", name: "Weapon", type: "DataDefinition", payload: { kind: "dataDefinition", fields: [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" },
        { id: "kit", name: "Kit", typeId: "struct", typeClassId: "kit" },
      ] } },
    ]);
    const entry = createDataEntryForDefinition("weapon", schemas.dataDefinitions!.weapon!.fields, schemas);
    expect(entry.schema).toEqual([
      { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" },
      { id: "kit", name: "Kit", typeId: "struct", typeClassId: "kit", fields: [
        { id: "sound", name: "Sound", typeId: "asset", typeClassId: "Audio", loading: "hard" },
        { id: "skin", name: "Skin", typeId: "asset", typeClassId: "Texture" },
      ] },
    ]);
  });
});
