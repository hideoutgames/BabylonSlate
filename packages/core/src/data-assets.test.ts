import { describe, expect, it } from "vitest";
import { createDataObjectAsset, normalizeDataObjectAsset, normalizeDataSheetAsset } from "./data-assets";

describe("data asset payloads", () => {
  it("preserves detached authored values and unknown fields while opening an object", () => {
    const source = {
      kind: "dataObject", structureGuid: " stats ",
      values: { Health: 12, RemovedField: { label: "keep me" } },
      schema: [{ id: "health", name: "Health", typeId: "int" }],
    };
    const opened = normalizeDataObjectAsset(source);
    expect(opened.values).toEqual({ Health: 12, RemovedField: { label: "keep me" } });
    expect(opened.structureGuid).toBe("stats");
    (opened.values.RemovedField as { label: string }).label = "edited";
    opened.schema![0]!.name = "Other";
    expect(source.values.RemovedField.label).toBe("keep me");
    expect(source.schema[0]!.name).toBe("Health");
  });

  it("keeps ordered unique sheet membership without manufacturing embedded rows", () => {
    expect(normalizeDataSheetAsset({
      structureGuid: "stats", objectGuids: ["sword", " shield ", "sword", "", 3, null],
    })).toEqual({ kind: "dataSheet", structureGuid: "stats", objectGuids: ["sword", "shield"] });
    expect(createDataObjectAsset("stats", { Health: 10 })).toEqual({
      kind: "dataObject", structureGuid: "stats", values: { Health: 10 },
    });
  });
});
