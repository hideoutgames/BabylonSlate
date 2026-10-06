import { describe, expect, it } from "vitest";
import { createDataDefinitionAsset, createDataSheetAsset, createDataSheetRow, type DataSheetRow } from "@babylonslate/core";
import {
  createDataRowForDefinition,
  reconcileDataRow,
  resolveDataRowValues,
  serializeDataRowValues,
  validateDataRow,
  validateDataDefinition,
  validateDataSheet,
} from "./data-values";
import { dataTypeSchemas } from "./data-catalog";
import type { StructField } from "./type-assets";
import type { TypeSchemas } from "./type-defaults";

const schemasFor = (fields: StructField[]): TypeSchemas => ({ structs: { stats: { name: "Stats", fields } }, dataDefinitions: { stats: { name: "Stats", fields } }, enums: {} });

describe("authored Data Sheet entries", () => {
  it("copies nested defaults at creation and never inherits later edits to defaults", () => {
    const fields: StructField[] = [
      { name: "Offset", typeId: "vec3", defaultValue: { x: 1, y: 2, z: 3 } },
      { name: "Pose", typeId: "transform" },
    ];
    const schemas = schemasFor(fields);
    const first = createDataRowForDefinition("stats", fields, schemas);
    const second = createDataRowForDefinition("stats", fields, schemas);
    (first.values.Offset as { x: number }).x = 42;
    (fields[0]!.defaultValue as { y: number }).y = 99;
    expect(second.values.Offset).toEqual({ x: 1, y: 2, z: 3 });
    expect(resolveDataRowValues(first, "stats", schemas)?.Offset).toEqual({ x: 42, y: 2, z: 3 });
    expect(validateDataRow(second, "stats", schemas)).toEqual([]);
  });

  it("requires explicit reconciliation for newly added fields and leaves the original object untouched", () => {
    const original = createDataRowForDefinition("stats", [{ id: "hp", name: "Health", typeId: "int", defaultValue: 10 }]);
    const fields: StructField[] = [
      { id: "hp", name: "Health", typeId: "int", defaultValue: 99 },
      { id: "mana", name: "Mana", typeId: "int", defaultValue: 20 },
    ];
    const schemas = schemasFor(fields);
    expect(resolveDataRowValues(original, "stats", schemas)).toBeNull();
    expect(validateDataRow(original, "stats", schemas)).toContainEqual(expect.objectContaining({ code: "missing-field", path: "Mana" }));
    const migrated = reconcileDataRow(original, "stats", fields, schemas);
    expect(migrated.row.values).toEqual({ Health: 10, Mana: 20 });
    expect(migrated.changes).toEqual([{ kind: "added", path: "Mana" }]);
    expect(original.values).toEqual({ Health: 10 });
  });

  it("resolves stable field renames through nested Definitions and preserves removed authored values", () => {
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
    initial.dataDefinitions = initial.structs;
    const asset = createDataRowForDefinition("stats", initial.structs.stats!.fields, initial);
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
    current.dataDefinitions = current.structs;
    const runtime = resolveDataRowValues(asset, "stats", current)!;
    expect(runtime).toEqual({ HitPoints: 35, Settings: { Power: 8 } });
    (runtime.Settings as { Power: number }).Power = 100;
    expect(asset.values.Config).toEqual({ Damage: 8, Other: "retained" });
    const migrated = reconcileDataRow(asset, "stats", current.structs.stats!.fields, current);
    expect(migrated.row.values).toEqual({ HitPoints: 35, Settings: { Power: 8, Other: "retained" }, OldTexture: "texture-guid" });
    expect(migrated.row.schema).toContainEqual({ id: "old", name: "OldTexture", typeId: "asset", typeClassId: "Texture" });
    expect(migrated.changes).toContainEqual({ kind: "renamed", path: "Settings.Power", previousPath: "Settings.Damage" });
  });

  it("supports simultaneous swapped names without overwriting either field", () => {
    const asset = createDataRowForDefinition("stats", [
      { id: "a", name: "Left", typeId: "int", defaultValue: 1 },
      { id: "b", name: "Right", typeId: "int", defaultValue: 2 },
    ]);
    const fields: StructField[] = [
      { id: "a", name: "Right", typeId: "int" },
      { id: "b", name: "Left", typeId: "int" },
    ];
    expect(resolveDataRowValues(asset, "stats", schemasFor(fields))).toEqual({ Right: 1, Left: 2 });
    expect(reconcileDataRow(asset, "stats", fields).row.values).toEqual({ Right: 1, Left: 2 });
  });

  it("fails conflicting migrations atomically instead of discarding either value", () => {
    const asset = createDataRowForDefinition("stats", [{ id: "hp", name: "Health", typeId: "int", defaultValue: 5 }]);
    asset.values.HitPoints = 25;
    const fields: StructField[] = [{ id: "hp", name: "HitPoints", typeId: "int" }];
    const migrated = reconcileDataRow(asset, "stats", fields, schemasFor(fields));
    expect(migrated.row).toBe(asset);
    expect(migrated.row.values).toEqual({ Health: 5, HitPoints: 25 });
    expect(migrated.issues).toContainEqual(expect.objectContaining({ code: "rename-conflict", severity: "error" }));
    expect(resolveDataRowValues(asset, "stats", schemasFor(fields))).toBeNull();
  });

  it("preserves incompatible values on type changes and blocks typed runtime reads", () => {
    const asset = createDataRowForDefinition("stats", [{ name: "Health", typeId: "string", defaultValue: "twenty" }]);
    const fields: StructField[] = [{ id: "legacy:Health", name: "Health", typeId: "int", defaultValue: 20 }];
    const schemas = schemasFor(fields);
    const migrated = reconcileDataRow(asset, "stats", fields, schemas);
    expect(migrated.row.values.Health).toBe("twenty");
    expect(migrated.changes).toContainEqual({ kind: "typeChanged", path: "Health" });
    expect(migrated.issues).toContainEqual(expect.objectContaining({ code: "type-mismatch", path: "Health" }));
    expect(resolveDataRowValues(migrated.row, "stats", schemas)).toBeNull();
  });

  it("retains nested reference metadata until an incompatible value is explicitly repaired", () => {
    const initial: TypeSchemas = { enums: {}, structs: {
      stats: { name: "Stats", fields: [{ id: "field", name: "Config", typeId: "struct", typeClassId: "inner" }] },
      inner: { name: "Inner", fields: [{ id: "texture", name: "Texture", typeId: "asset", typeClassId: "Texture", defaultValue: "texture-guid" }] },
    } };
    initial.dataDefinitions = initial.structs;
    const asset = createDataRowForDefinition("stats", initial.structs.stats!.fields, initial);
    const fields: StructField[] = [{ id: "field", name: "Config", typeId: "int" }];
    const migrated = reconcileDataRow(asset, "stats", fields, schemasFor(fields));
    expect(migrated.row.values.Config).toEqual({ Texture: "texture-guid" });
    expect(migrated.row.schema![0]).toMatchObject({
      typeId: "struct", typeClassId: "inner", fields: [{ name: "Texture", typeId: "asset", typeClassId: "Texture" }],
    });
    migrated.row.values.Config = 7;
    const repaired = reconcileDataRow(migrated.row, "stats", fields, schemasFor(fields));
    expect(repaired.row.schema![0]).toEqual({ id: "field", name: "Config", typeId: "int" });
    expect(resolveDataRowValues(repaired.row, "stats", schemasFor(fields))).toEqual({ Config: 7 });
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
    const asset = createDataSheetRow("Entry", { Team: "Red", Health: NaN, Texture: "material", Sound: "deleted", Target: "actor1" });
    const issues = validateDataRow(asset, "stats", schemas, { assetTypeForGuid: (guid) => guid === "material" ? "Material" : null });
    expect(issues.map(({ path, code }) => [path, code])).toEqual(expect.arrayContaining([
      ["Team", "type-mismatch"], ["Health", "type-mismatch"], ["Texture", "asset-type"], ["Sound", "missing-asset"], ["Target", "type-mismatch"],
    ]));
  });

  it("rejects malformed schemas and non-JSON values without mutating them", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const asset: DataSheetRow = { id: "row", name: "Entry", values: { A: cycle } };
    const schemas = schemasFor([{ id: "duplicate", name: "A", typeId: "wildcard" }, { id: "duplicate", name: "B", typeId: "float" }]);
    const issues = validateDataRow(asset, "stats", schemas);
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid-value" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid-schema" }));
    expect(resolveDataRowValues(asset, "stats", schemas)).toBeNull();
    expect(asset.values.A).toBe(cycle);
    expect(validateDataRow({ ...asset, values: {} }, "__proto__", schemas)).toContainEqual(
      expect.objectContaining({ code: "missing-definition" }),
    );
  });

  it("treats prototype-like field names as data and does not mutate object prototypes", () => {
    const fields: StructField[] = [{ name: "__proto__", typeId: "string", defaultValue: "authored" }];
    const asset = createDataRowForDefinition("stats", fields);
    expect(Object.getPrototypeOf(asset.values)).toBe(Object.prototype);
    expect(Object.keys(asset.values)).toEqual(["__proto__"]);
    expect(resolveDataRowValues(asset, "stats", schemasFor(fields))).toEqual(JSON.parse('{"__proto__":"authored"}'));
  });
});

describe("Data Sheet Row tags and typed collections", () => {
  it("creates portable detached defaults and round-trips native Maps through authoring", () => {
    const fields: StructField[] = [
      { name: "Category", typeId: "tag" },
      { name: "Labels", typeId: "struct", typeClassId: "engine:TagContainer" },
      { name: "Scores", typeId: "float", container: "map", keyTypeId: "tag" },
      { name: "Points", typeId: "vec3", container: "array", defaultValue: [{ x: 1, y: 2, z: 3 }] },
    ];
    const schemas = schemasFor(fields);
    const first = createDataRowForDefinition("stats", fields, schemas);
    const second = createDataRowForDefinition("stats", fields, schemas);
    expect(first.values).toEqual({ Category: 0, Labels: { Tags: [] }, Scores: [], Points: [{ x: 1, y: 2, z: 3 }] });
    expect(validateDataRow(first, "stats", schemas)).toEqual([]);
    (first.values.Points as Array<{ x: number }>)[0]!.x = 99;
    expect(second.values.Points).toEqual([{ x: 1, y: 2, z: 3 }]);
    const authored = serializeDataRowValues({ ...second.values, Scores: new Map([[4, 12.5]]) }, fields, schemas);
    expect(authored.Scores).toEqual([{ key: 4, value: 12.5 }]);
    second.values = authored;
    const runtime = resolveDataRowValues(second, "stats", schemas)!;
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
    const asset = createDataRowForDefinition("stats", fields);
    asset.values = { Tags: [0, 0xffff_ffff, -1, 0x1_0000_0000], Icons: [
      { key: 3, value: "texture" }, { key: 3, value: "missing" }, { key: "bad", value: 3 },
    ] };
    const errors = validateDataRow(asset, "stats", schemasFor(fields), { assetTypeForGuid: (guid) => guid === "texture" ? "Texture" : null });
    expect(errors.map(({ code, path }) => [code, path])).toEqual(expect.arrayContaining([
      ["type-mismatch", "Tags.2"], ["type-mismatch", "Tags.3"], ["duplicate-key", "Icons.1.key"],
      ["missing-asset", "Icons.1.value"], ["type-mismatch", "Icons.2.key"], ["type-mismatch", "Icons.2.value"],
    ]));
    expect(errors.some((entry) => entry.path === "Tags.0" || entry.path === "Tags.1")).toBe(false);
    expect(resolveDataRowValues(asset, "stats", schemasFor(fields))).toBeNull();
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
    initial.dataDefinitions = initial.structs;
    const asset = createDataRowForDefinition("stats", fields, initial);
    asset.values = {
      Rows: [{ Health: 12, Icon: "texture-a" }, { Health: 30, Icon: "texture-b" }],
      Lookup: [{ key: { Code: "first" }, value: { Health: 25, Icon: "texture-c" } }],
    };
    const current: TypeSchemas = { enums: {}, structs: { ...initial.structs,
      inner: { name: "Inner", fields: [{ id: "hp", name: "HitPoints", typeId: "int" }, { id: "rate", name: "Rate", typeId: "float", defaultValue: 2 }] },
      key: { name: "Key", fields: [{ id: "key", name: "Id", typeId: "string" }] },
    } };
    current.dataDefinitions = current.structs;
    const migrated = reconcileDataRow(asset, "stats", fields, current);
    expect(migrated.row.values).toEqual({
      Rows: [{ HitPoints: 12, Rate: 2, Icon: "texture-a" }, { HitPoints: 30, Rate: 2, Icon: "texture-b" }],
      Lookup: [{ key: { Id: "first" }, value: { HitPoints: 25, Rate: 2, Icon: "texture-c" } }],
    });
    expect(migrated.row.schema![0]!.fields).toContainEqual({ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" });
    expect(migrated.row.schema![1]!.keyFields).toEqual([{ id: "key", name: "Id", typeId: "string" }]);
    expect(resolveDataRowValues(migrated.row, "stats", current)).toEqual({
      Rows: [{ HitPoints: 12, Rate: 2 }, { HitPoints: 30, Rate: 2 }],
      Lookup: new Map([[{ Id: "first" }, { HitPoints: 25, Rate: 2 }]]),
    });
    expect(asset.values.Rows).toEqual([{ Health: 12, Icon: "texture-a" }, { Health: 30, Icon: "texture-b" }]);

    // Invalid collection shapes remain authored data, not scalar records to migrate.
    const malformed = { ...asset, values: {
      Rows: { Health: 12, Icon: "texture-a" },
      Lookup: { Health: 25, Icon: "texture-c" },
    } };
    const preserved = reconcileDataRow(malformed, "stats", fields, current);
    expect(preserved.row.values).toEqual(malformed.values);
    expect(preserved.row.schema).toEqual(asset.schema);
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
    const asset = createDataRowForDefinition("stats", oldFields);
    const fields: StructField[] = [
      { name: "Icons", typeId: "int", container: "map", keyTypeId: "tag" },
      { name: "Lookup", typeId: "float", container: "map", keyTypeId: "tag" },
    ];
    const migrated = reconcileDataRow(asset, "stats", fields, schemasFor(fields));
    expect(migrated.row.values).toEqual({ Icons: ["texture"], Lookup: [{ key: "texture", value: 4 }] });
    expect(migrated.row.schema).toEqual(asset.schema);
    expect(migrated.changes).toEqual([{ kind: "typeChanged", path: "Icons" }, { kind: "typeChanged", path: "Lookup" }]);
    expect(resolveDataRowValues(migrated.row, "stats", schemasFor(fields))).toBeNull();
  });

  it("serializes nested native Map defaults when explicitly adding a field", () => {
    const fields: StructField[] = [{ name: "Lookup", typeId: "vec3", container: "map", defaultValue: new Map([["first", { x: 1, y: 2, z: 3 }]]) }];
    const migrated = reconcileDataRow(createDataSheetRow("Entry"), "stats", fields, schemasFor(fields));
    expect(migrated.row.values).toEqual({ Lookup: [{ key: "first", value: { x: 1, y: 2, z: 3 } }] });
    expect(validateDataRow(migrated.row, "stats", schemasFor(fields))).toEqual([]);
  });
});

describe("independent Data Definitions", () => {
  it.each([
    { container: "single" as const, key: false },
    { container: "array" as const, key: false },
    { container: "map" as const, key: false },
    { container: "map" as const, key: true },
  ])("rejects mutual schema recursion without defaults ($container, key=$key)", ({ container, key }) => {
    const first = createDataDefinitionAsset([{ id: "child", name: "Child", typeId: "struct", typeClassId: "second" }]);
    const second = createDataDefinitionAsset([key
      ? { id: "back", name: "Back", typeId: "int", container, keyTypeId: "struct", keyTypeClassId: "first" }
      : { id: "back", name: "Back", typeId: "struct", typeClassId: "first", container }]);
    const schemas = dataTypeSchemas([
      { guid: "first", name: "First", type: "DataDefinition", payload: first },
      { guid: "second", name: "Second", type: "DataDefinition", payload: second },
    ]);
    expect(validateDataDefinition(first, schemas, "first")).toContainEqual(expect.objectContaining({
      code: "recursive-schema", severity: "error", path: key ? "Child.Back.key" : "Child.Back",
    }));
  });

  it("rejects schema chains beyond 64 levels even without authored defaults", () => {
    const definitions = Array.from({ length: 65 }, (_, index) => createDataDefinitionAsset(index === 64 ? [] : [
      { id: "next", name: "Next", typeId: "struct", typeClassId: `definition-${index + 1}` },
    ]));
    const schemas = dataTypeSchemas(definitions.map((payload, index) => ({
      guid: `definition-${index}`, name: `Definition ${index}`, type: "DataDefinition" as const, payload,
    })));
    expect(validateDataDefinition(definitions[0]!, schemas, "definition-0")).toContainEqual(expect.objectContaining({ code: "recursive-schema", severity: "error" }));
  });

  it("defines nested typed rows without any Structure asset and enforces authored rules", () => {
    const nested = createDataDefinitionAsset([{ id: "power", name: "Power", typeId: "float", defaultValue: 5, min: 1, max: 10 }]);
    const definition = createDataDefinitionAsset([
      { id: "label", name: "Label", typeId: "string", required: true, category: "Identity", description: "Display Label" },
      { id: "stats", name: "Stats", typeId: "struct", typeClassId: "nested" },
    ]);
    const schemas = dataTypeSchemas([
      { guid: "definition", name: "Weapon", type: "DataDefinition", payload: definition },
      { guid: "nested", name: "Stats", type: "DataDefinition", payload: nested },
    ]);
    expect(validateDataDefinition(definition, schemas, "definition")).toEqual([]);
    const row = createDataRowForDefinition("definition", definition.fields, schemas, "Sword", "sword");
    expect(row.values).toEqual({ Label: "", Stats: { Power: 5 } });
    expect(validateDataRow(row, "definition", schemas)).toContainEqual(expect.objectContaining({ code: "required", path: "Label", rowId: "sword" }));
    row.values.Label = "Iron Sword";
    expect(resolveDataRowValues(row, "definition", schemas)).toEqual({ Label: "Iron Sword", Stats: { Power: 5 } });
    row.values.Stats = { Power: 12 };
    expect(validateDataRow(row, "definition", schemas)).toContainEqual(expect.objectContaining({ code: "out-of-range", path: "Stats.Power" }));
    expect(definition.fields[0]).toMatchObject({ category: "Identity", description: "Display Label", required: true });
  });

  it("rejects invalid defaults, ranges and actual Structure assets as root or nested definitions", () => {
    const structure = { name: "Legacy", fields: [{ name: "Health", typeId: "int" }] };
    const schemas: TypeSchemas = { enums: {}, structs: { legacy: structure }, dataDefinitions: {} };
    expect(validateDataRow(createDataSheetRow("Row", { Health: 1 }), "legacy", schemas)).toContainEqual(expect.objectContaining({ code: "missing-definition" }));
    const definition = createDataDefinitionAsset([
      { id: "nested", name: "Nested", typeId: "struct", typeClassId: "legacy" },
      { id: "amount", name: "Amount", typeId: "int", defaultValue: "five" },
      { id: "range", name: "Range", typeId: "float", min: 5, max: 1 },
      { id: "limited", name: "Limited", typeId: "float", defaultValue: 9, max: 3 },
    ]);
    const issues = validateDataDefinition(definition, schemas, "definition");
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-structure", path: "Nested" }),
      expect.objectContaining({ code: "type-mismatch", path: "Amount" }),
      expect.objectContaining({ code: "invalid-range", path: "Range" }),
      expect.objectContaining({ code: "out-of-range", path: "Limited" }),
    ]));
  });

  it("reports ambiguous sheet row identities and names without deleting or deduplicating entries", () => {
    const definition = createDataDefinitionAsset([{ id: "health", name: "Health", typeId: "int", defaultValue: 10 }]);
    const schemas = dataTypeSchemas([{ guid: "definition", name: "Stats", type: "DataDefinition", payload: definition }]);
    const rows = [createDataSheetRow("Sword", { Health: 3 }, undefined, "row"), createDataSheetRow(" sword ", { Health: 4 }, undefined, "row")];
    const sheet = createDataSheetAsset("definition", rows);
    expect(validateDataSheet(sheet, schemas)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate-row", rowId: "row" }),
      expect.objectContaining({ code: "duplicate-row-name", rowId: "row" }),
    ]));
    expect(sheet.rows.map((row) => row.values.Health)).toEqual([3, 4]);
  });
});
