import { describe, expect, it } from "vitest";
import { createDataDefinitionAsset, createDataSheetAsset, createDataSheetRow, normalizeDataDefinitionAsset, normalizeDataSheetAsset } from "./data-assets";

describe("Definition and sheet payloads", () => {
  it("owns detached ordered row values and schema snapshots inside the sheet", () => {
    const row = createDataSheetRow("Sword", { Health: 12, RemovedField: { label: "keep me" } }, [{ id: "health", name: "Health", typeId: "int" }], "sword");
    const source = createDataSheetAsset("stats", [row]);
    const opened = normalizeDataSheetAsset(source);
    expect(opened.rows[0]).toEqual(row);
    (opened.rows[0]!.values.RemovedField as { label: string }).label = "edited";
    opened.rows[0]!.schema![0]!.name = "Other";
    expect(source.rows[0]!.values.RemovedField).toEqual({ label: "keep me" });
    expect(row.schema![0]!.name).toBe("Health");
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

  it("refuses legacy reference sheets and former object payloads without silently discarding their data", () => {
    const oldSheet = { kind: "dataSheet", structureGuid: "stats", objectGuids: ["sword", "shield"] };
    expect(() => normalizeDataSheetAsset(oldSheet)).toThrow(/Legacy/);
    expect(oldSheet.objectGuids).toEqual(["sword", "shield"]);
    expect(() => normalizeDataDefinitionAsset({ kind: "dataObject", structureGuid: "stats", values: { Health: 10 } })).toThrow();
    expect(() => normalizeDataSheetAsset({ kind: "dataSheet", definitionGuid: "stats", rows: [{ id: "broken", name: "Broken", values: null }] })).toThrow();
  });
});
