import { describe, expect, it } from "vitest";
import { defaultSaveGameDefinition } from "./save-game-catalog";
import { scriptPaletteNodes, defaultNodeRegistry } from "../services/graph-validation";

describe("default Save Game field catalog", () => {
  it("uses unsaved renamed fields and stable IDs for typed read/write/migration nodes", () => {
    const definition = { id: "progress", schemaVersion: 1, fields: [{ id: "coins-id", name: "Coins", type: "int", defaultValue: 5 }] };
    const selected = defaultSaveGameDefinition("asset-id", [{ path: "/Content/Progress.blsave", header: { type: "SaveGame", guid: "asset-id", payload: definition } }],
      [{ ref: { kind: "save-game", path: "/Content/Progress.blsave" }, content: { ...definition, fields: [{ ...definition.fields[0], name: "Gold" }] } }]);
    const rows = scriptPaletteNodes(defaultNodeRegistry, { parentClass: "Actor", saveGameDefinition: selected });
    const get = rows.find((row) => row.id === "saveGame.getField:coins-id");
    const set = rows.find((row) => row.id === "saveGame.setField:coins-id");
    expect(get?.title).toBe("Get Save Gold");
    expect(get?.pins.find((pin) => pin.id === "value")?.type).toEqual({ kind: "int" });
    expect(set?.defaultData).toMatchObject({ fieldId: "coins-id", "default:value": 5 });
    expect(rows.find((row) => row.id === "saveGame.migrationSetField:coins-id")?.pins.find((pin) => pin.id === "value")?.type).toEqual({ kind: "int" });
  });
});
