import { describe, expect, it } from "vitest";
import { createDataObjectAsset, type DataObjectAsset } from "@babylonslate/core";
import {
  createDataObjectForStructure,
  reconcileDataObject,
  resolveDataObjectValues,
  serializeDataObjectValues,
  validateDataObject,
} from "./data-values";
import type { StructField } from "./type-assets";
import type { TypeSchemas } from "./type-defaults";

const schemasFor = (fields: StructField[]): TypeSchemas => ({ structs: { stats: { name: "Stats", fields } }, enums: {} });

describe("authored Data Object values", () => {
  it("copies nested defaults at creation and never inherits later edits to defaults", () => {
    const fields: StructField[] = [
      { name: "Offset", typeId: "vec3", defaultValue: { x: 1, y: 2, z: 3 } },
      { name: "Pose", typeId: "transform" },
    ];
    const schemas = schemasFor(fields);
    const first = createDataObjectForStructure("stats", fields, schemas);
    const second = createDataObjectForStructure("stats", fields, schemas);
    (first.values.Offset as { x: number }).x = 42;
    (fields[0]!.defaultValue as { y: number }).y = 99;
    expect(second.values.Offset).toEqual({ x: 1, y: 2, z: 3 });
    expect(resolveDataObjectValues(first, schemas)?.Offset).toEqual({ x: 42, y: 2, z: 3 });
    expect(validateDataObject(second, schemas)).toEqual([]);
  });

  it("requires explicit reconciliation for newly added fields and leaves the original object untouched", () => {
    const original = createDataObjectForStructure("stats", [{ id: "hp", name: "Health", typeId: "int", defaultValue: 10 }]);
    const fields: StructField[] = [
      { id: "hp", name: "Health", typeId: "int", defaultValue: 99 },
      { id: "mana", name: "Mana", typeId: "int", defaultValue: 20 },
    ];
    const schemas = schemasFor(fields);
    expect(resolveDataObjectValues(original, schemas)).toBeNull();
    expect(validateDataObject(original, schemas)).toContainEqual(expect.objectContaining({ code: "missing-field", path: "Mana" }));
    const migrated = reconcileDataObject(original, fields, schemas);
    expect(migrated.asset.values).toEqual({ Health: 10, Mana: 20 });
    expect(migrated.changes).toEqual([{ kind: "added", path: "Mana" }]);
    expect(original.values).toEqual({ Health: 10 });
  });

  it("resolves stable field renames through nested Structures and preserves removed authored values", () => {
    const initial: TypeSchemas = {
      enums: {}, structs: {
        stats: { name: "Stats", fields: [
          { id: "hp", name: "Health", typeId: "int" },
          { id: "nested", name: "Config", typeId: "struct", typeClassId: "inner" },
          { id: "old", name: "OldTexture", typeId: "asset", typeClassId: "Texture" },
        ] },
        inner: { name: "Inner", fields: [{ id: "damage", name: "Damage", typeId: "float" }] },
      },
    };
    const asset = createDataObjectForStructure("stats", initial.structs.stats!.fields, initial);
    asset.values = { Health: 35, Config: { Damage: 8, Other: "retained" }, OldTexture: "texture-guid" };
    const current: TypeSchemas = {
      enums: {}, structs: {
        stats: { name: "Stats", fields: [
          { id: "hp", name: "HitPoints", typeId: "int" },
          { id: "nested", name: "Settings", typeId: "struct", typeClassId: "inner" },
        ] },
        inner: { name: "Inner", fields: [{ id: "damage", name: "Power", typeId: "float" }] },
      },
    };
    const runtime = resolveDataObjectValues(asset, current)!;
    expect(runtime).toEqual({ HitPoints: 35, Settings: { Power: 8 } });
    (runtime.Settings as { Power: number }).Power = 100;
    expect(asset.values.Config).toEqual({ Damage: 8, Other: "retained" });
    const migrated = reconcileDataObject(asset, current.structs.stats!.fields, current);
    expect(migrated.asset.values).toEqual({ HitPoints: 35, Settings: { Power: 8, Other: "retained" }, OldTexture: "texture-guid" });
    expect(migrated.asset.schema).toContainEqual({ id: "old", name: "OldTexture", typeId: "asset", typeClassId: "Texture" });
    expect(migrated.changes).toContainEqual({ kind: "renamed", path: "Settings.Power", previousPath: "Settings.Damage" });
  });

  it("supports simultaneous swapped names without overwriting either field", () => {
    const asset = createDataObjectForStructure("stats", [
      { id: "a", name: "Left", typeId: "int", defaultValue: 1 },
      { id: "b", name: "Right", typeId: "int", defaultValue: 2 },
    ]);
    const fields: StructField[] = [
      { id: "a", name: "Right", typeId: "int" },
      { id: "b", name: "Left", typeId: "int" },
    ];
    expect(resolveDataObjectValues(asset, schemasFor(fields))).toEqual({ Right: 1, Left: 2 });
    expect(reconcileDataObject(asset, fields).asset.values).toEqual({ Right: 1, Left: 2 });
  });

  it("fails conflicting migrations atomically instead of discarding either value", () => {
    const asset = createDataObjectForStructure("stats", [{ id: "hp", name: "Health", typeId: "int", defaultValue: 5 }]);
    asset.values.HitPoints = 25;
    const fields: StructField[] = [{ id: "hp", name: "HitPoints", typeId: "int" }];
    const migrated = reconcileDataObject(asset, fields, schemasFor(fields));
    expect(migrated.asset).toBe(asset);
    expect(migrated.asset.values).toEqual({ Health: 5, HitPoints: 25 });
    expect(migrated.issues).toContainEqual(expect.objectContaining({ code: "rename-conflict", severity: "error" }));
    expect(resolveDataObjectValues(asset, schemasFor(fields))).toBeNull();
  });

  it("preserves incompatible values on type changes and blocks typed runtime reads", () => {
    const asset = createDataObjectForStructure("stats", [{ name: "Health", typeId: "string", defaultValue: "twenty" }]);
    const fields: StructField[] = [{ id: "legacy:Health", name: "Health", typeId: "int", defaultValue: 20 }];
    const schemas = schemasFor(fields);
    const migrated = reconcileDataObject(asset, fields, schemas);
    expect(migrated.asset.values.Health).toBe("twenty");
    expect(migrated.changes).toContainEqual({ kind: "typeChanged", path: "Health" });
    expect(migrated.issues).toContainEqual(expect.objectContaining({ code: "type-mismatch", path: "Health" }));
    expect(resolveDataObjectValues(migrated.asset, schemas)).toBeNull();
  });

  it("retains nested reference metadata until an incompatible value is explicitly repaired", () => {
    const initial: TypeSchemas = { enums: {}, structs: {
      stats: { name: "Stats", fields: [{ id: "field", name: "Config", typeId: "struct", typeClassId: "inner" }] },
      inner: { name: "Inner", fields: [{ id: "texture", name: "Texture", typeId: "asset", typeClassId: "Texture", defaultValue: "texture-guid" }] },
    } };
    const asset = createDataObjectForStructure("stats", initial.structs.stats!.fields, initial);
    const fields: StructField[] = [{ id: "field", name: "Config", typeId: "int" }];
    const migrated = reconcileDataObject(asset, fields, schemasFor(fields));
    expect(migrated.asset.values.Config).toEqual({ Texture: "texture-guid" });
    expect(migrated.asset.schema![0]).toMatchObject({
      typeId: "struct", typeClassId: "inner", fields: [{ name: "Texture", typeId: "asset", typeClassId: "Texture" }],
    });
    migrated.asset.values.Config = 7;
    const repaired = reconcileDataObject(migrated.asset, fields, schemasFor(fields));
    expect(repaired.asset.schema![0]).toEqual({ id: "field", name: "Config", typeId: "int" });
    expect(resolveDataObjectValues(repaired.asset, schemasFor(fields))).toEqual({ Config: 7 });
  });

  it("checks enum membership, finite numbers, reference kinds and live-instance values", () => {
    const fields: StructField[] = [
      { name: "Team", typeId: "enum", typeClassId: "team" },
      { name: "Health", typeId: "int" },
      { name: "Texture", typeId: "asset", typeClassId: "Texture" },
      { name: "Sound", typeId: "asset", typeClassId: "Audio" },
      { name: "Target", typeId: "actor" },
    ];
    const schemas = schemasFor(fields);
    schemas.enums = { team: { name: "Team", members: [{ name: "Blue", value: 1 }] } };
    const asset = createDataObjectAsset("stats", { Team: "Red", Health: NaN, Texture: "material", Sound: "deleted", Target: "actor1" });
    const issues = validateDataObject(asset, schemas, { assetTypeForGuid: (guid) => guid === "material" ? "Material" : null });
    expect(issues.map(({ path, code }) => [path, code])).toEqual(expect.arrayContaining([
      ["Team", "type-mismatch"], ["Health", "type-mismatch"], ["Texture", "asset-type"], ["Sound", "missing-asset"], ["Target", "type-mismatch"],
    ]));
  });

  it("rejects malformed schemas and non-JSON values without mutating them", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const asset: DataObjectAsset = { kind: "dataObject", structureGuid: "stats", values: { A: cycle } };
    const schemas = schemasFor([{ id: "duplicate", name: "A", typeId: "wildcard" }, { id: "duplicate", name: "B", typeId: "float" }]);
    const issues = validateDataObject(asset, schemas);
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid-value" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid-schema" }));
    expect(resolveDataObjectValues(asset, schemas)).toBeNull();
    expect(asset.values.A).toBe(cycle);
    expect(validateDataObject({ ...asset, structureGuid: "__proto__", values: {} }, schemas)).toContainEqual(
      expect.objectContaining({ code: "missing-structure" }),
    );
  });

  it("treats prototype-like field names as data and does not mutate object prototypes", () => {
    const fields: StructField[] = [{ name: "__proto__", typeId: "string", defaultValue: "authored" }];
    const asset = createDataObjectForStructure("stats", fields);
    expect(Object.getPrototypeOf(asset.values)).toBe(Object.prototype);
    expect(Object.keys(asset.values)).toEqual(["__proto__"]);
    expect(resolveDataObjectValues(asset, schemasFor(fields))).toEqual(JSON.parse('{"__proto__":"authored"}'));
  });
});

describe("Data Object tags and typed collections", () => {
  it("creates portable detached defaults and round-trips native Maps through authoring", () => {
    const fields: StructField[] = [
      { name: "Category", typeId: "tag" },
      { name: "Labels", typeId: "struct", typeClassId: "engine:TagContainer" },
      { name: "Scores", typeId: "float", container: "map", keyTypeId: "tag" },
      { name: "Points", typeId: "vec3", container: "array", defaultValue: [{ x: 1, y: 2, z: 3 }] },
    ];
    const schemas = schemasFor(fields);
    const first = createDataObjectForStructure("stats", fields, schemas);
    const second = createDataObjectForStructure("stats", fields, schemas);
    expect(first.values).toEqual({ Category: 0, Labels: { Tags: [] }, Scores: [], Points: [{ x: 1, y: 2, z: 3 }] });
    expect(validateDataObject(first, schemas)).toEqual([]);
    (first.values.Points as Array<{ x: number }>)[0]!.x = 99;
    expect(second.values.Points).toEqual([{ x: 1, y: 2, z: 3 }]);
    const authored = serializeDataObjectValues({ ...second.values, Scores: new Map([[4, 12.5]]) }, fields, schemas);
    expect(authored.Scores).toEqual([{ key: 4, value: 12.5 }]);
    second.values = authored;
    const runtime = resolveDataObjectValues(second, schemas)!;
    expect(runtime.Scores).toEqual(new Map([[4, 12.5]]));
    (runtime.Scores as Map<number, number>).set(4, 200);
    expect(second.values.Scores).toEqual([{ key: 4, value: 12.5 }]);
    expect(second.schema).toContainEqual(expect.objectContaining({ name: "Scores", container: "map", keyTypeId: "tag" }));
  });

  it("validates every collection value and key and rejects destructive duplicate primitive keys", () => {
    const fields: StructField[] = [
      { name: "Tags", typeId: "tag", container: "array" },
      { name: "Icons", typeId: "asset", typeClassId: "Texture", container: "map", keyTypeId: "tag" },
    ];
    const asset = createDataObjectForStructure("stats", fields);
    asset.values = { Tags: [0, 0xffff_ffff, -1, 0x1_0000_0000], Icons: [
      { key: 3, value: "texture" }, { key: 3, value: "missing" }, { key: "bad", value: 3 },
    ] };
    const errors = validateDataObject(asset, schemasFor(fields), { assetTypeForGuid: (guid) => guid === "texture" ? "Texture" : null });
    expect(errors.map(({ code, path }) => [code, path])).toEqual(expect.arrayContaining([
      ["type-mismatch", "Tags.2"], ["type-mismatch", "Tags.3"], ["duplicate-key", "Icons.1.key"],
      ["missing-asset", "Icons.1.value"], ["type-mismatch", "Icons.2.key"], ["type-mismatch", "Icons.2.value"],
    ]));
    expect(errors.some((entry) => entry.path === "Tags.0" || entry.path === "Tags.1")).toBe(false);
    expect(resolveDataObjectValues(asset, schemasFor(fields))).toBeNull();
  });

  it("migrates nested array/map key and value renames while retaining removed values and reference metadata", () => {
    const fields: StructField[] = [
      { name: "Rows", typeId: "struct", typeClassId: "inner", container: "array" },
      { name: "Lookup", typeId: "struct", typeClassId: "inner", container: "map", keyTypeId: "struct", keyTypeClassId: "key" },
    ];
    const initial = schemasFor(fields);
    initial.structs = { ...initial.structs,
      inner: { name: "Inner", fields: [
        { id: "hp", name: "Health", typeId: "int" },
        { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
      ] },
      key: { name: "Key", fields: [{ id: "key", name: "Code", typeId: "string" }] },
    };
    const asset = createDataObjectForStructure("stats", fields, initial);
    asset.values = {
      Rows: [{ Health: 12, Icon: "texture-a" }, { Health: 30, Icon: "texture-b" }],
      Lookup: [{ key: { Code: "first" }, value: { Health: 25, Icon: "texture-c" } }],
    };
    const current: TypeSchemas = { enums: {}, structs: { ...initial.structs,
      inner: { name: "Inner", fields: [{ id: "hp", name: "HitPoints", typeId: "int" }, { id: "rate", name: "Rate", typeId: "float", defaultValue: 2 }] },
      key: { name: "Key", fields: [{ id: "key", name: "Id", typeId: "string" }] },
    } };
    const migrated = reconcileDataObject(asset, fields, current);
    expect(migrated.asset.values).toEqual({
      Rows: [{ HitPoints: 12, Rate: 2, Icon: "texture-a" }, { HitPoints: 30, Rate: 2, Icon: "texture-b" }],
      Lookup: [{ key: { Id: "first" }, value: { HitPoints: 25, Rate: 2, Icon: "texture-c" } }],
    });
    expect(migrated.asset.schema![0]!.fields).toContainEqual({ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" });
    expect(migrated.asset.schema![1]!.keyFields).toEqual([{ id: "key", name: "Id", typeId: "string" }]);
    expect(resolveDataObjectValues(migrated.asset, current)).toEqual({
      Rows: [{ HitPoints: 12, Rate: 2 }, { HitPoints: 30, Rate: 2 }],
      Lookup: new Map([[{ Id: "first" }, { HitPoints: 25, Rate: 2 }]]),
    });
    expect(asset.values.Rows).toEqual([{ Health: 12, Icon: "texture-a" }, { Health: 30, Icon: "texture-b" }]);

    // Invalid collection shapes remain authored data, not scalar Structures to migrate.
    const malformed = { ...asset, values: {
      Rows: { Health: 12, Icon: "texture-a" },
      Lookup: { Health: 25, Icon: "texture-c" },
    } };
    const preserved = reconcileDataObject(malformed, fields, current);
    expect(preserved.asset.values).toEqual(malformed.values);
    expect(preserved.asset.schema).toEqual(asset.schema);
    expect(preserved.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "type-mismatch", path: "Rows" }),
      expect.objectContaining({ code: "type-mismatch", path: "Lookup" }),
    ]));
  });

  it("preserves incompatible container/key types and their reference metadata until repaired", () => {
    const oldFields: StructField[] = [
      { name: "Icons", typeId: "asset", typeClassId: "Texture", container: "array", defaultValue: ["texture"] },
      { name: "Lookup", typeId: "float", container: "map", keyTypeId: "asset", keyTypeClassId: "Texture", defaultValue: [{ key: "texture", value: 4 }] },
    ];
    const asset = createDataObjectForStructure("stats", oldFields);
    const fields: StructField[] = [
      { name: "Icons", typeId: "int", container: "map", keyTypeId: "tag" },
      { name: "Lookup", typeId: "float", container: "map", keyTypeId: "tag" },
    ];
    const migrated = reconcileDataObject(asset, fields, schemasFor(fields));
    expect(migrated.asset.values).toEqual({ Icons: ["texture"], Lookup: [{ key: "texture", value: 4 }] });
    expect(migrated.asset.schema).toEqual(asset.schema);
    expect(migrated.changes).toEqual([{ kind: "typeChanged", path: "Icons" }, { kind: "typeChanged", path: "Lookup" }]);
    expect(resolveDataObjectValues(migrated.asset, schemasFor(fields))).toBeNull();
  });

  it("serializes nested native Map defaults when explicitly adding a field", () => {
    const fields: StructField[] = [{ name: "Lookup", typeId: "vec3", container: "map", defaultValue: new Map([["first", { x: 1, y: 2, z: 3 }]]) }];
    const migrated = reconcileDataObject(createDataObjectAsset("stats"), fields, schemasFor(fields));
    expect(migrated.asset.values).toEqual({ Lookup: [{ key: "first", value: { x: 1, y: 2, z: 3 } }] });
    expect(validateDataObject(migrated.asset, schemasFor(fields))).toEqual([]);
  });
});
