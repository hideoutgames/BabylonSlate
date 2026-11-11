import { describe, expect, it } from "vitest";
import { decodeAssetDocument, encodeAssetDocument, readAssetDocumentHeader } from "@haptic/assets";
import { defaultSaveGameDefinition, loadDefaultSaveGameDefinition, resolveSaveGameDefinition, saveableStructures } from "./save-game-catalog";
import { ENGINE_STRUCTS, mergeEngineTypeSchemas } from "@haptic/scripting";
import { scriptPaletteNodes, defaultNodeRegistry } from "../services/graph-validation";

describe("default Save Game field catalog", () => {
  it("uses unsaved renamed fields and stable IDs for typed read/write/migration nodes", () => {
    const definition = { id: "progress", schemaVersion: 1, fields: [{ id: "coins-id", name: "Coins", type: "int", defaultValue: 5 }] };
    const selected = defaultSaveGameDefinition("asset-id", [{ path: "/Content/Progress.hasset", header: { type: "SaveGame", guid: "asset-id", payload: {} } }],
      [{ ref: { kind: "save-game", path: "/Content/Progress.hasset" }, content: { ...definition, fields: [{ ...definition.fields[0], name: "Gold" }] } }]);
    const rows = scriptPaletteNodes(defaultNodeRegistry(), { parentClass: "Actor", saveGameDefinition: selected });
    const get = rows.find((row) => row.id === "saveGame.getField:coins-id");
    const set = rows.find((row) => row.id === "saveGame.setField:coins-id");
    expect(get?.title).toBe("Get Save Gold");
    expect(get?.pins?.find((pin) => pin.id === "value")?.type).toEqual({ kind: "int" });
    expect(set?.defaultData).toMatchObject({ fieldId: "coins-id", "default:value": 5 });
    expect(rows.find((row) => row.id === "saveGame.migrationSetField:coins-id")?.pins?.find((pin) => pin.id === "value")?.type).toEqual({ kind: "int" });
  });

  it("loads typed fields from a closed asset's actual document chunk", async () => {
    const bytes = await encodeAssetDocument({ type: "SaveGame", name: "Progress", guid: "asset-id", version: 1,
      payload: { id: "progress", schemaVersion: 1, fields: [{ id: "health-id", name: "Health", type: "float", defaultValue: 100 }] } });
    const assets = [{ path: "/Content/Progress.hasset", header: readAssetDocumentHeader(bytes) }];
    const selected = await loadDefaultSaveGameDefinition("asset-id", assets, [], async (kind, path) => {
      if (kind !== "save-game" || path !== "/Content/Progress.hasset") throw new Error("Wrong asset request");
      return (await decodeAssetDocument(bytes)).payload;
    });
    const rows = scriptPaletteNodes(defaultNodeRegistry(), { parentClass: "Actor", saveGameDefinition: selected });
    expect(rows.find((row) => row.id === "saveGame.setField:health-id")?.defaultData).toMatchObject({ "default:value": 100 });
    expect(rows.find((row) => row.id === "saveGame.getField:health-id")?.pins?.find((pin) => pin.id === "value")?.type).toEqual({ kind: "float" });
  });

  it("offers only Structures without object references, nested ones included", () => {
    const schemas = mergeEngineTypeSchemas({ structs: {
      loadout: { name: "Loadout", fields: [{ name: "Spread", typeId: "struct", typeClassId: "engine:FloatRange" }, { name: "Icon", typeId: "asset" }] },
      squad: { name: "Squad", fields: [{ name: "Leader", typeId: "struct", typeClassId: "member" }] },
      member: { name: "Member", fields: [{ name: "Actor", typeId: "object", typeClassId: "Actor" }] },
    } });
    const structures = [
      ...ENGINE_STRUCTS.map((entry) => ({ guid: entry.id, name: entry.name })),
      { guid: "loadout", name: "Loadout" }, { guid: "squad", name: "Squad" }, { guid: "member", name: "Member" },
    ];
    const names = saveableStructures(structures, schemas).map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["Int Range", "Float Curve", "Color Curve", "Loadout"]));
    expect(names).not.toContain("Hit Result");
    expect(names).not.toContain("Squad");
    expect(names).not.toContain("Member");
  });
});

describe("Save Games linked to a Data Definition", () => {
  const dataDefinition = (fields: object[]) => mergeEngineTypeSchemas({
    enums: { difficulty: { name: "Difficulty", members: [{ name: "Easy", value: 0 }, { name: "Hard", value: 1 }] } },
    structs: { squad: { name: "Squad", fields: [{ name: "Leader", typeId: "object", typeClassId: "Actor" }] } },
    dataDefinitions: { progress: { name: "ProgressFields", fields } as never },
  });
  const linked = { id: "save", schemaVersion: 1, fields: [], dataDefinitionId: "progress", defaults: { "coins-id": 50, "spawn-id": "not a vector" } };
  const fields = [
    { id: "coins-id", name: "Coins", typeId: "int", defaultValue: 5 },
    { id: "spawn-id", name: "Spawn", typeId: "vec3", defaultValue: { x: 1, y: 2, z: 3 } },
    { id: "facing-id", name: "Facing", typeId: "rotator" },
    { id: "banner-id", name: "Banner", typeId: "asset", defaultValue: "" },
    { id: "ranks-id", name: "Ranks", typeId: "int", container: "map", keyTypeId: "enum", keyTypeClassId: "difficulty", defaultValue: [{ key: "Hard", value: 3 }] },
    { id: "unlocks-id", name: "Unlocks", typeId: "tag", container: "array" },
    { id: "squad-id", name: "Squad", typeId: "struct", typeClassId: "squad" },
  ];

  it("takes field IDs, names, types and defaults from the Data Definition, with valid overrides winning", () => {
    const resolved = resolveSaveGameDefinition(linked, dataDefinition(fields));
    expect(resolved.missingDataDefinition).toBe(false);
    expect(resolved.definition.fields).toEqual([
      { id: "coins-id", name: "Coins", type: "int", defaultValue: 50 },
      // The override no longer fits a Vector3, so the Data Definition's default applies.
      { id: "spawn-id", name: "Spawn", type: "vector3", defaultValue: { x: 1, y: 2, z: 3 } },
      { id: "facing-id", name: "Facing", type: "rotator", defaultValue: { pitch: 0, yaw: 0, roll: 0 } },
      { id: "banner-id", name: "Banner", type: "asset", defaultValue: null },
      { id: "ranks-id", name: "Ranks", type: "int", container: "map", keyType: "enum", keyEnumId: "difficulty", defaultValue: [{ key: "Hard", value: 3 }] },
      { id: "unlocks-id", name: "Unlocks", type: "tag", container: "array", defaultValue: [] },
    ]);
    expect(resolved.skipped).toEqual([{ name: "Squad", reason: "Its Structure is missing or holds object references." }]);
  });

  it("follows Data Definition edits without changing field identity", () => {
    const renamed = fields.map((field) => field.id === "coins-id" ? { ...field, name: "Gold", typeId: "float" } : field);
    expect(resolveSaveGameDefinition(linked, dataDefinition(renamed)).definition.fields[0]).toEqual({ id: "coins-id", name: "Gold", type: "float", defaultValue: 50 });
  });

  it("reports a missing Data Definition instead of inventing fields", () => {
    expect(resolveSaveGameDefinition({ ...linked, dataDefinitionId: "deleted" }, dataDefinition(fields)))
      .toMatchObject({ missingDataDefinition: true, definition: { fields: [] } });
  });
});
