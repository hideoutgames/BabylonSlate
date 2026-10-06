import { describe, expect, it } from "vitest";
import { createDataDefinitionAsset, type DataDefinitionField } from "@babylonslate/core";
import { dataTypeSchemas } from "./data-catalog";
import { createDataEntryForDefinition, reconcileDataDefinitionDefault, resolveDataEntryValues, validateDataDefinition } from "./data-values";
import { defaultValueForMember, type TypeSchemas } from "./type-defaults";

function fixture() {
  const child = createDataDefinitionAsset([
    { id: "count", name: "Count", typeId: "int", defaultValue: 1 },
    { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
  ]);
  const parent = createDataDefinitionAsset();
  const dataDefinitions = { child: { name: "Child", fields: child.fields }, parent: { name: "Parent", fields: parent.fields } };
  const schemas: TypeSchemas = { structs: dataDefinitions, dataDefinitions, enums: {} };
  return { child, parent, schemas, dataDefinitions };
}

describe("authored nested Definition defaults", () => {
  it("projects stable renames for static records and new entries while retaining retired references and missing fields", () => {
    const { child, parent, schemas } = fixture();
    parent.fields.push(reconcileDataDefinitionDefault({ id: "child", name: "Child", typeId: "struct", typeClassId: "child", defaultValue: { Count: 3, Icon: "texture-guid" } }, schemas));
    child.fields[0]!.name = "Total";
    child.fields.splice(1, 1);

    const catalog = dataTypeSchemas([
      { guid: "child", name: "Child", type: "DataDefinition", payload: child },
      { guid: "parent", name: "Parent", type: "DataDefinition", payload: parent },
    ]);
    expect(validateDataDefinition(parent, catalog, "parent").filter(issue => issue.severity === "error")).toEqual([]);
    expect(defaultValueForMember("struct", "parent", catalog)).toEqual({ Child: { Total: 3, Icon: "texture-guid" } });
    const created = createDataEntryForDefinition("parent", catalog.dataDefinitions!.parent!.fields, catalog);
    expect(created.values).toEqual({ Child: { Total: 3, Icon: "texture-guid" } });
    expect(created.schema?.[0]?.fields).toContainEqual({ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" });
    expect(resolveDataEntryValues(created, "parent", catalog)).toEqual({ Child: { Total: 3 } });
    expect(parent.fields[0]!.defaultValue).toEqual({ Count: 3, Icon: "texture-guid" });

    child.fields.push({ id: "note", name: "Note", typeId: "string", defaultValue: "new default" });
    const projected = reconcileDataDefinitionDefault(parent.fields[0]!, schemas);
    expect(projected.defaultValue).toEqual({ Total: 3, Icon: "texture-guid" });
    expect(validateDataDefinition(parent, schemas, "parent")).toContainEqual(expect.objectContaining({ code: "missing-field", path: "Child.Note" }));
    expect(defaultValueForMember("struct", "parent", schemas)).toEqual({ Child: { Total: 3, Icon: "texture-guid" } });
  });

  it("carries retained snapshots through generated enclosing record defaults", () => {
    const { child, parent, schemas, dataDefinitions } = fixture();
    parent.fields.push(reconcileDataDefinitionDefault({ id: "child", name: "Child", typeId: "struct", typeClassId: "child", defaultValue: { Count: 5, Icon: "texture-guid" } }, schemas));
    child.fields.splice(1, 1);
    const outer = createDataDefinitionAsset([{ id: "parent", name: "Parent", typeId: "struct", typeClassId: "parent" }]);
    const withOuter: TypeSchemas = { ...schemas, structs: { ...dataDefinitions, outer: { name: "Outer", fields: outer.fields } }, dataDefinitions: { ...dataDefinitions, outer: { name: "Outer", fields: outer.fields } } };
    const created = createDataEntryForDefinition("outer", outer.fields, withOuter);
    expect(created.values).toEqual({ Parent: { Child: { Count: 5, Icon: "texture-guid" } } });
    expect(created.schema?.[0]?.fields?.[0]?.fields).toContainEqual({ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" });
  });

  it("projects every occupied array and map key/value and retains collection reference metadata", () => {
    const { child, schemas } = fixture();
    const fields = ([
      { id: "items", name: "Items", typeId: "struct", typeClassId: "child", container: "array", defaultValue: [{ Count: 2, Icon: "array-icon" }] },
      { id: "map", name: "Map", typeId: "struct", typeClassId: "child", container: "map", keyTypeId: "struct", keyTypeClassId: "child", defaultValue: [{ key: { Count: 4, Icon: "key-icon" }, value: { Count: 6, Icon: "value-icon" } }] },
    ] satisfies DataDefinitionField[]).map(field => reconcileDataDefinitionDefault(field, schemas));
    child.fields[0]!.name = "Total";
    child.fields.splice(1, 1);
    const projected = fields.map(field => reconcileDataDefinitionDefault(field, schemas));
    expect(projected.map(field => field.defaultValue)).toEqual([
      [{ Total: 2, Icon: "array-icon" }], [{ key: { Total: 4, Icon: "key-icon" }, value: { Total: 6, Icon: "value-icon" } }],
    ]);
    for (const snapshot of [projected[0]!.fields, projected[1]!.fields, projected[1]!.keyFields]) {
      expect(snapshot).toContainEqual({ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" });
    }
    expect(validateDataDefinition(createDataDefinitionAsset(fields), schemas).some(issue => issue.severity === "error")).toBe(false);
  });

  it("keeps defaults atomic on identity conflicts and retains changed-type references in sparse records", () => {
    const { child, schemas } = fixture();
    const field = reconcileDataDefinitionDefault({ id: "child", name: "Child", typeId: "struct", typeClassId: "child", defaultValue: { Count: 3, Icon: "texture-guid" } }, schemas);
    child.fields[1] = { id: "replacement", name: "Icon", typeId: "string" };
    expect(reconcileDataDefinitionDefault(field, schemas)).toBe(field);
    child.fields[1] = { id: "icon", name: "Icon", typeId: "string" };
    const array = reconcileDataDefinitionDefault({ ...field, container: "array", defaultValue: [{ Count: 1 }, { Count: 2, Icon: "texture-guid" }] }, schemas);
    expect(array.defaultValue).toEqual([{ Count: 1 }, { Count: 2, Icon: "texture-guid" }]);
    expect(array.fields).toContainEqual({ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" });
  });
});
