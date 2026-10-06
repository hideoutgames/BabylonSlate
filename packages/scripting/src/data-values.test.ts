import { describe, expect, it } from "vitest";
import { createDataDefinitionAsset, createDataTreeAsset, createDataTreeEntry, type DataTreeEntry, type DataFieldSnapshot } from "@babylonslate/core";
import {
  createDataEntryForDefinition,
  reconcileDataEntry,
  resolveDataEntryValues,
  serializeDataEntryValues,
  validateDataEntry,
  validateDataDefinition,
  validateDataTree,
} from "./data-values";
import { dataTypeSchemas } from "./data-catalog";
import type { StructField } from "./type-assets";
import type { TypeSchemas } from "./type-defaults";

const createEntry = (name: string, values: Record<string, unknown> = {}, schema?: DataFieldSnapshot[], id?: string): DataTreeEntry =>
  createDataTreeEntry({ name, values, schema, id });

const schemasFor = (fields: StructField[]): TypeSchemas => ({ structs: { stats: { name: "Stats", fields } }, dataDefinitions: { stats: { name: "Stats", fields } }, enums: {} });

describe("authored Data Tree entries", () => {
  it("copies nested defaults at creation and never inherits later edits to defaults", () => {
    const fields: StructField[] = [
      { name: "Offset", typeId: "vec3", defaultValue: { x: 1, y: 2, z: 3 } },
      { name: "Pose", typeId: "transform" },
    ];
    const schemas = schemasFor(fields);
    const first = createDataEntryForDefinition("stats", fields, schemas);
    const second = createDataEntryForDefinition("stats", fields, schemas);
    (first.values.Offset as { x: number }).x = 42;
    (fields[0]!.defaultValue as { y: number }).y = 99;
    expect(second.values.Offset).toEqual({ x: 1, y: 2, z: 3 });
    expect(resolveDataEntryValues(first, "stats", schemas)?.Offset).toEqual({ x: 42, y: 2, z: 3 });
    expect(validateDataEntry(second, "stats", schemas)).toEqual([]);
  });

  it("requires explicit reconciliation for newly added fields and leaves the original object untouched", () => {
    const original = createDataEntryForDefinition("stats", [{ id: "hp", name: "Health", typeId: "int", defaultValue: 10 }]);
    const fields: StructField[] = [
      { id: "hp", name: "Health", typeId: "int", defaultValue: 99 },
      { id: "mana", name: "Mana", typeId: "int", defaultValue: 20 },
    ];
    const schemas = schemasFor(fields);
    expect(resolveDataEntryValues(original, "stats", schemas)).toBeNull();
    expect(validateDataEntry(original, "stats", schemas)).toContainEqual(expect.objectContaining({ code: "missing-field", path: "Mana" }));
    const migrated = reconcileDataEntry(original, "stats", fields, schemas);
    expect(migrated.entry.values).toEqual({ Health: 10, Mana: 20 });
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
    const asset = createDataEntryForDefinition("stats", initial.structs.stats!.fields, initial);
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
    const runtime = resolveDataEntryValues(asset, "stats", current)!;
    expect(runtime).toEqual({ HitPoints: 35, Settings: { Power: 8 } });
    (runtime.Settings as { Power: number }).Power = 100;
    expect(asset.values.Config).toEqual({ Damage: 8, Other: "retained" });
    const migrated = reconcileDataEntry(asset, "stats", current.structs.stats!.fields, current);
    expect(migrated.entry.values).toEqual({ HitPoints: 35, Settings: { Power: 8, Other: "retained" }, OldTexture: "texture-guid" });
    expect(migrated.entry.schema).toContainEqual({ id: "old", name: "OldTexture", typeId: "asset", typeClassId: "Texture" });
    expect(migrated.changes).toContainEqual({ kind: "renamed", path: "Settings.Power", previousPath: "Settings.Damage" });
  });

  it("supports simultaneous swapped names without overwriting either field", () => {
    const asset = createDataEntryForDefinition("stats", [
      { id: "a", name: "Left", typeId: "int", defaultValue: 1 },
      { id: "b", name: "Right", typeId: "int", defaultValue: 2 },
    ]);
    const fields: StructField[] = [
      { id: "a", name: "Right", typeId: "int" },
      { id: "b", name: "Left", typeId: "int" },
    ];
    expect(resolveDataEntryValues(asset, "stats", schemasFor(fields))).toEqual({ Right: 1, Left: 2 });
    expect(reconcileDataEntry(asset, "stats", fields).entry.values).toEqual({ Right: 1, Left: 2 });
  });

  it("fails conflicting migrations atomically instead of discarding either value", () => {
    const asset = createDataEntryForDefinition("stats", [{ id: "hp", name: "Health", typeId: "int", defaultValue: 5 }]);
    asset.values.HitPoints = 25;
    const fields: StructField[] = [{ id: "hp", name: "HitPoints", typeId: "int" }];
    const migrated = reconcileDataEntry(asset, "stats", fields, schemasFor(fields));
    expect(migrated.entry).toBe(asset);
    expect(migrated.entry.values).toEqual({ Health: 5, HitPoints: 25 });
    expect(migrated.issues).toContainEqual(expect.objectContaining({ code: "rename-conflict", severity: "error" }));
    expect(resolveDataEntryValues(asset, "stats", schemasFor(fields))).toBeNull();
    expect(reconcileDataEntry(asset, "stats", fields, schemasFor(fields), { initializeMissingFields: false }).entry).toBe(asset);
  });

  it("preserves incompatible values on type changes and blocks typed runtime reads", () => {
    const asset = createDataEntryForDefinition("stats", [{ name: "Health", typeId: "string", defaultValue: "twenty" }]);
    const fields: StructField[] = [{ id: "legacy:Health", name: "Health", typeId: "int", defaultValue: 20 }];
    const schemas = schemasFor(fields);
    const migrated = reconcileDataEntry(asset, "stats", fields, schemas);
    expect(migrated.entry.values.Health).toBe("twenty");
    expect(migrated.changes).toContainEqual({ kind: "typeChanged", path: "Health" });
    expect(migrated.issues).toContainEqual(expect.objectContaining({ code: "type-mismatch", path: "Health" }));
    expect(resolveDataEntryValues(migrated.entry, "stats", schemas)).toBeNull();
  });

  it("retains nested reference metadata until an incompatible value is explicitly repaired", () => {
    const initial: TypeSchemas = { enums: {}, structs: {
      stats: { name: "Stats", fields: [{ id: "field", name: "Config", typeId: "struct", typeClassId: "inner" }] },
      inner: { name: "Inner", fields: [{ id: "texture", name: "Texture", typeId: "asset", typeClassId: "Texture", defaultValue: "texture-guid" }] },
    } };
    initial.dataDefinitions = initial.structs;
    const asset = createDataEntryForDefinition("stats", initial.structs.stats!.fields, initial);
    const fields: StructField[] = [{ id: "field", name: "Config", typeId: "int" }];
    const migrated = reconcileDataEntry(asset, "stats", fields, schemasFor(fields));
    expect(migrated.entry.values.Config).toEqual({ Texture: "texture-guid" });
    expect(migrated.entry.schema![0]).toMatchObject({
      typeId: "struct", typeClassId: "inner", fields: [{ name: "Texture", typeId: "asset", typeClassId: "Texture" }],
    });
    migrated.entry.values.Config = 7;
    const repaired = reconcileDataEntry(migrated.entry, "stats", fields, schemasFor(fields));
    expect(repaired.entry.schema![0]).toEqual({ id: "field", name: "Config", typeId: "int" });
    expect(resolveDataEntryValues(repaired.entry, "stats", schemasFor(fields))).toEqual({ Config: 7 });
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
    const asset = createEntry("Entry", { Team: "Red", Health: NaN, Texture: "material", Sound: "deleted", Target: "actor1" });
    const issues = validateDataEntry(asset, "stats", schemas, { assetTypeForGuid: (guid) => guid === "material" ? "Material" : null });
    expect(issues.map(({ path, code }) => [path, code])).toEqual(expect.arrayContaining([
      ["Team", "type-mismatch"], ["Health", "type-mismatch"], ["Texture", "asset-type"], ["Sound", "missing-asset"], ["Target", "type-mismatch"],
    ]));
  });

  it("rejects malformed schemas and non-JSON values without mutating them", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const asset: DataTreeEntry = { id: "row", parentId: null, name: "Entry", values: { A: cycle } };
    const schemas = schemasFor([{ id: "duplicate", name: "A", typeId: "wildcard" }, { id: "duplicate", name: "B", typeId: "float" }]);
    const issues = validateDataEntry(asset, "stats", schemas);
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid-value" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "invalid-schema" }));
    expect(resolveDataEntryValues(asset, "stats", schemas)).toBeNull();
    expect(asset.values.A).toBe(cycle);
    expect(validateDataEntry({ ...asset, values: {} }, "__proto__", schemas)).toContainEqual(
      expect.objectContaining({ code: "missing-definition" }),
    );
  });

  it("treats prototype-like field names as data and does not mutate object prototypes", () => {
    const fields: StructField[] = [{ name: "__proto__", typeId: "string", defaultValue: "authored" }];
    const asset = createDataEntryForDefinition("stats", fields);
    expect(Object.getPrototypeOf(asset.values)).toBe(Object.prototype);
    expect(Object.keys(asset.values)).toEqual(["__proto__"]);
    expect(resolveDataEntryValues(asset, "stats", schemasFor(fields))).toEqual(JSON.parse('{"__proto__":"authored"}'));
  });
});

describe("Data Tree entry tags and typed collections", () => {
  it("projects safe nested renames without adopting missing defaults across scalar, array and map records", () => {
    const fields: StructField[] = [
      { id: "item", name: "Item", typeId: "struct", typeClassId: "inner" },
      { id: "items", name: "Items", typeId: "struct", typeClassId: "inner", container: "array" },
      { id: "lookup", name: "Lookup", typeId: "struct", typeClassId: "inner", container: "map", keyTypeId: "struct", keyTypeClassId: "inner" },
    ];
    const initial = schemasFor(fields);
    initial.structs = { ...initial.structs, inner: { name: "Item", fields: [
      { id: "price", name: "Price", typeId: "int" },
      { id: "icon", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" },
    ] } };
    initial.dataDefinitions = initial.structs;
    let authored = createDataEntryForDefinition("stats", fields, initial);
    const item = { Price: 7, RemovedIcon: "icon-guid" };
    authored.values = { Item: { ...item }, Items: [{ ...item }], Lookup: [{ key: { ...item }, value: { ...item } }] };
    // Populating collections authors their nested identities before subsequent
    // schema edits; empty collection defaults carry only shallow metadata.
    authored = reconcileDataEntry(authored, "stats", fields, initial).entry;
    const current = schemasFor([...fields, { id: "status", name: "Status", typeId: "string", defaultValue: "Ready" }]);
    current.structs = { ...current.structs, inner: { name: "Item", fields: [
      { id: "price", name: "Cost", typeId: "int" },
      { id: "quantity", name: "Quantity", typeId: "int", defaultValue: 9 },
    ] } };
    current.dataDefinitions = current.structs;
    const projected = reconcileDataEntry(authored, "stats", current.structs.stats!.fields, current, { initializeMissingFields: false });
    const renamed = { Cost: 7, RemovedIcon: "icon-guid" };
    expect(projected.entry.values).toEqual({ Item: renamed, Items: [renamed], Lookup: [{ key: renamed, value: renamed }] });
    expect(projected.entry.schema![2]!.keyFields).toContainEqual({ id: "icon", name: "RemovedIcon", typeId: "asset", typeClassId: "Texture" });
    expect(projected.issues.filter((issue) => issue.code === "missing-field").map((issue) => issue.path)).toEqual([
      "Item.Quantity", "Items.0.Quantity", "Lookup.0.key.Quantity", "Lookup.0.value.Quantity", "Status",
    ]);
    expect(authored.values.Item).toEqual(item);
    expect(reconcileDataEntry(projected.entry, "stats", current.structs.stats!.fields, current).entry.values.Status).toBe("Ready");
  });

  it("creates portable detached defaults and round-trips native Maps through authoring", () => {
    const fields: StructField[] = [
      { name: "Category", typeId: "tag" },
      { name: "Labels", typeId: "struct", typeClassId: "engine:TagContainer" },
      { name: "Scores", typeId: "float", container: "map", keyTypeId: "tag" },
      { name: "Points", typeId: "vec3", container: "array", defaultValue: [{ x: 1, y: 2, z: 3 }] },
    ];
    const schemas = schemasFor(fields);
    const first = createDataEntryForDefinition("stats", fields, schemas);
    const second = createDataEntryForDefinition("stats", fields, schemas);
    expect(first.values).toEqual({ Category: 0, Labels: { Tags: [] }, Scores: [], Points: [{ x: 1, y: 2, z: 3 }] });
    expect(validateDataEntry(first, "stats", schemas)).toEqual([]);
    (first.values.Points as Array<{ x: number }>)[0]!.x = 99;
    expect(second.values.Points).toEqual([{ x: 1, y: 2, z: 3 }]);
    const authored = serializeDataEntryValues({ ...second.values, Scores: new Map([[4, 12.5]]) }, fields, schemas);
    expect(authored.Scores).toEqual([{ key: 4, value: 12.5 }]);
    second.values = authored;
    const runtime = resolveDataEntryValues(second, "stats", schemas)!;
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
    const asset = createDataEntryForDefinition("stats", fields);
    asset.values = { Tags: [0, 0xffff_ffff, -1, 0x1_0000_0000], Icons: [
      { key: 3, value: "texture" }, { key: 3, value: "missing" }, { key: "bad", value: 3 },
    ] };
    const errors = validateDataEntry(asset, "stats", schemasFor(fields), { assetTypeForGuid: (guid) => guid === "texture" ? "Texture" : null });
    expect(errors.map(({ code, path }) => [code, path])).toEqual(expect.arrayContaining([
      ["type-mismatch", "Tags.2"], ["type-mismatch", "Tags.3"], ["duplicate-key", "Icons.1.key"],
      ["missing-asset", "Icons.1.value"], ["type-mismatch", "Icons.2.key"], ["type-mismatch", "Icons.2.value"],
    ]));
    expect(errors.some((entry) => entry.path === "Tags.0" || entry.path === "Tags.1")).toBe(false);
    expect(resolveDataEntryValues(asset, "stats", schemasFor(fields))).toBeNull();
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
    let asset = createDataEntryForDefinition("stats", fields, initial);
    asset.values = {
      Rows: [{ Health: 12, Icon: "texture-a" }, { Health: 30, Icon: "texture-b" }],
      Lookup: [{ key: { Code: "first" }, value: { Health: 25, Icon: "texture-c" } }],
    };
    // Authoring the formerly empty collections captures their populated
    // nested fields before a later Definition edit renames those fields.
    asset = reconcileDataEntry(asset, "stats", fields, initial).entry;
    const current: TypeSchemas = { enums: {}, structs: { ...initial.structs,
      inner: { name: "Inner", fields: [{ id: "hp", name: "HitPoints", typeId: "int" }, { id: "rate", name: "Rate", typeId: "float", defaultValue: 2 }] },
      key: { name: "Key", fields: [{ id: "key", name: "Id", typeId: "string" }] },
    } };
    current.dataDefinitions = current.structs;
    const migrated = reconcileDataEntry(asset, "stats", fields, current);
    expect(migrated.entry.values).toEqual({
      Rows: [{ HitPoints: 12, Rate: 2, Icon: "texture-a" }, { HitPoints: 30, Rate: 2, Icon: "texture-b" }],
      Lookup: [{ key: { Id: "first" }, value: { HitPoints: 25, Rate: 2, Icon: "texture-c" } }],
    });
    expect(migrated.entry.schema![0]!.fields).toContainEqual({ id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" });
    expect(migrated.entry.schema![1]!.keyFields).toEqual([{ id: "key", name: "Id", typeId: "string" }]);
    expect(resolveDataEntryValues(migrated.entry, "stats", current)).toEqual({
      Rows: [{ HitPoints: 12, Rate: 2 }, { HitPoints: 30, Rate: 2 }],
      Lookup: new Map([[{ Id: "first" }, { HitPoints: 25, Rate: 2 }]]),
    });
    expect(asset.values.Rows).toEqual([{ Health: 12, Icon: "texture-a" }, { Health: 30, Icon: "texture-b" }]);

    // Invalid collection shapes remain authored data, not scalar records to migrate.
    const malformed = { ...asset, values: {
      Rows: { Health: 12, Icon: "texture-a" },
      Lookup: { Health: 25, Icon: "texture-c" },
    } };
    const preserved = reconcileDataEntry(malformed, "stats", fields, current);
    expect(preserved.entry.values).toEqual(malformed.values);
    expect(preserved.entry.schema).toEqual(asset.schema);
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
    const asset = createDataEntryForDefinition("stats", oldFields);
    const fields: StructField[] = [
      { name: "Icons", typeId: "int", container: "map", keyTypeId: "tag" },
      { name: "Lookup", typeId: "float", container: "map", keyTypeId: "tag" },
    ];
    const migrated = reconcileDataEntry(asset, "stats", fields, schemasFor(fields));
    expect(migrated.entry.values).toEqual({ Icons: ["texture"], Lookup: [{ key: "texture", value: 4 }] });
    expect(migrated.entry.schema).toEqual(asset.schema);
    expect(migrated.changes).toEqual([{ kind: "typeChanged", path: "Icons" }, { kind: "typeChanged", path: "Lookup" }]);
    expect(resolveDataEntryValues(migrated.entry, "stats", schemasFor(fields))).toBeNull();
  });

  it("serializes nested native Map defaults when explicitly adding a field", () => {
    const fields: StructField[] = [{ name: "Lookup", typeId: "vec3", container: "map", defaultValue: new Map([["first", { x: 1, y: 2, z: 3 }]]) }];
    const migrated = reconcileDataEntry(createEntry("Entry"), "stats", fields, schemasFor(fields));
    expect(migrated.entry.values).toEqual({ Lookup: [{ key: "first", value: { x: 1, y: 2, z: 3 } }] });
    expect(validateDataEntry(migrated.entry, "stats", schemasFor(fields))).toEqual([]);
  });
});

describe("independent Data Definitions", () => {
  it("validates reusable schema DAGs without expanding every reference path", () => {
    const definitions = Array.from({ length: 24 }, (_, index) => createDataDefinitionAsset(index === 23 ? [] : [
      { id: "left", name: "Left", typeId: "struct", typeClassId: `definition-${index + 1}`, container: "array" },
      { id: "right", name: "Right", typeId: "struct", typeClassId: `definition-${index + 1}`, container: "array" },
    ]));
    let schemaReads = 0;
    const dataDefinitions = Object.fromEntries(definitions.map((definition, index) => [`definition-${index}`, {
      name: `Definition ${index}`,
      get fields() {
        if (++schemaReads > definitions.length * 4) throw new Error("Schema validation expanded repeated reference paths.");
        return definition.fields;
      },
    }]));
    expect(validateDataDefinition(definitions[0]!, { enums: {}, structs: dataDefinitions, dataDefinitions }, "definition-0")).toEqual([]);
    // The number of authored schemas bounds work, although there are millions
    // of possible paths through their shared empty array element schemas.
    expect(schemaReads).toBeLessThan(definitions.length * 4);
    schemaReads = 0;
    definitions[23]!.fields.push({ id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer", defaultValue: { Tags: [], Retired: "preserved" } });
    const warnings = validateDataDefinition(definitions[0]!, { enums: {}, structs: dataDefinitions, dataDefinitions }, "definition-0");
    expect(warnings.some(issue => issue.code === "unknown-field")).toBe(true);
    expect(warnings.some(issue => issue.severity === "error")).toBe(false);
    expect(schemaReads).toBeLessThan(definitions.length * 4);
  });

  it("rechecks a shared subtree when reached with a smaller remaining depth budget", () => {
    const root = createDataDefinitionAsset([
      { id: "shallow", name: "Shallow", typeId: "struct", typeClassId: "shared" },
      { id: "deep", name: "Deep", typeId: "struct", typeClassId: "chain-0" },
    ]);
    const chain = Array.from({ length: 60 }, (_, index) => ({
      guid: `chain-${index}`, name: `Chain ${index}`, type: "DataDefinition" as const,
      payload: createDataDefinitionAsset([{ id: "next", name: "Next", typeId: "struct", typeClassId: index === 59 ? "shared" : `chain-${index + 1}` }]),
    }));
    const tail = ["shared", "middle-0", "middle-1", "middle-2"].map((guid, index, guids) => ({
      guid, name: guid, type: "DataDefinition" as const,
      payload: createDataDefinitionAsset(index === guids.length - 1 ? [] : [{ id: "next", name: "Next", typeId: "struct", typeClassId: guids[index + 1] }]),
    }));
    const schemas = dataTypeSchemas([{ guid: "root", name: "Root", type: "DataDefinition", payload: root }, ...chain, ...tail]);
    expect(validateDataDefinition(root, schemas, "root")).toContainEqual(expect.objectContaining({ code: "recursive-schema", severity: "error" }));
  });

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
    const row = createDataEntryForDefinition("definition", definition.fields, schemas, "Sword", "sword");
    expect(row.values).toEqual({ Label: "", Stats: { Power: 5 } });
    expect(validateDataEntry(row, "definition", schemas)).toContainEqual(expect.objectContaining({ code: "required", path: "Label", entryId: "sword" }));
    row.values.Label = "Iron Sword";
    expect(resolveDataEntryValues(row, "definition", schemas)).toEqual({ Label: "Iron Sword", Stats: { Power: 5 } });
    row.values.Stats = { Power: 12 };
    expect(validateDataEntry(row, "definition", schemas)).toContainEqual(expect.objectContaining({ code: "out-of-range", path: "Stats.Power" }));
    expect(definition.fields[0]).toMatchObject({ category: "Identity", description: "Display Label", required: true });
  });

  it("rejects invalid defaults, ranges and actual Structure assets as root or nested definitions", () => {
    const structure = { name: "Legacy", fields: [{ name: "Health", typeId: "int" }] };
    const schemas: TypeSchemas = { enums: {}, structs: { legacy: structure }, dataDefinitions: {} };
    expect(validateDataEntry(createEntry("Row", { Health: 1 }), "legacy", schemas)).toContainEqual(expect.objectContaining({ code: "missing-definition" }));
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

  it("validates per-branch Definitions while keeping untyped groups and owned values", () => {
    const first = createDataDefinitionAsset([{ id: "health", name: "Health", typeId: "int", defaultValue: 10 }]);
    const second = createDataDefinitionAsset([{ id: "label", name: "Label", typeId: "string", defaultValue: "Default" }]);
    const schemas = dataTypeSchemas([
      { guid: "first", name: "First", type: "DataDefinition", payload: first },
      { guid: "second", name: "Second", type: "DataDefinition", payload: second },
    ]);
    const entries = [
      createDataTreeEntry({ id: "parent", name: "Parent", values: { Health: 99 } }),
      createDataTreeEntry({ id: "child", parentId: "parent", name: "Child", values: { Health: 5 } }),
      createDataTreeEntry({ id: "group", name: "Group", definitionGuid: null, values: { Retained: "authored" } }),
      createDataTreeEntry({ id: "group-child", parentId: "group", name: "Nested Group" }),
      createDataTreeEntry({ id: "override", parentId: "group", name: "Typed", definitionGuid: "second", values: { Label: "Own" } }),
    ];
    const tree = createDataTreeAsset("first", entries);
    expect(validateDataTree(tree, schemas)).toEqual([]);
    expect(resolveDataEntryValues(tree.entries[1]!, "first", schemas)).toEqual({ Health: 5 });
    expect(resolveDataEntryValues(tree.entries[2]!, null, schemas)).toBeNull();
    expect(resolveDataEntryValues(tree.entries[4]!, "second", schemas)).toEqual({ Label: "Own" });
    tree.entries[1]!.parentId = "override";
    expect(validateDataTree(tree, schemas)).toContainEqual(expect.objectContaining({ code: "missing-field", path: "Label", entryId: "child" }));
    expect(tree.entries[1]!.values).toEqual({ Health: 5 });
    const reconciled = reconcileDataEntry(tree.entries[1]!, "second", second.fields, schemas);
    expect(reconciled.entry).toMatchObject({ id: "child", parentId: "override", name: "Child", values: { Health: 5, Label: "Default" } });
    expect(reconciled.entry.definitionGuid).toBeUndefined();
    expect(tree.entries[1]!.values).toEqual({ Health: 5 });
  });
});
