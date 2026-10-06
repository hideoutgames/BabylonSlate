import { describe, expect, it } from "vitest";
import { decodeAssetDocument, encodeAssetDocument, readAssetDocumentHeader } from "@babylonslate/assets";
import { defaultSaveGameDefinition, loadDefaultSaveGameDefinition } from "./save-game-catalog";
import { scriptPaletteNodes, defaultNodeRegistry } from "../services/graph-validation";

describe("default Save Game field catalog", () => {
  it("uses unsaved renamed fields and stable IDs for typed read/write/migration nodes", () => {
    const definition = { id: "progress", schemaVersion: 1, fields: [{ id: "coins-id", name: "Coins", type: "int", defaultValue: 5 }] };
    const selected = defaultSaveGameDefinition("asset-id", [{ path: "/Content/Progress.babasset", header: { type: "SaveGame", guid: "asset-id", payload: {} } }],
      [{ ref: { kind: "save-game", path: "/Content/Progress.babasset" }, content: { ...definition, fields: [{ ...definition.fields[0], name: "Gold" }] } }]);
    const rows = scriptPaletteNodes(defaultNodeRegistry, { parentClass: "Actor", saveGameDefinition: selected });
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
    const assets = [{ path: "/Content/Progress.babasset", header: readAssetDocumentHeader(bytes) }];
    const selected = await loadDefaultSaveGameDefinition("asset-id", assets, [], async (kind, path) => {
      if (kind !== "save-game" || path !== "/Content/Progress.babasset") throw new Error("Wrong asset request");
      return (await decodeAssetDocument(bytes)).payload;
    });
    const rows = scriptPaletteNodes(defaultNodeRegistry, { parentClass: "Actor", saveGameDefinition: selected });
    expect(rows.find((row) => row.id === "saveGame.setField:health-id")?.defaultData).toMatchObject({ "default:value": 100 });
    expect(rows.find((row) => row.id === "saveGame.getField:health-id")?.pins?.find((pin) => pin.id === "value")?.type).toEqual({ kind: "float" });
  });
});
