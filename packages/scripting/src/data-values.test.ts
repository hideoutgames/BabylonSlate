import { describe, expect, it } from "vitest";
import { createDataObjectAsset, type DataObjectAsset } from "@babylonslate/core";
import {
  createDataObjectForStructure,
  reconcileDataObject,
  resolveDataObjectValues,
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
