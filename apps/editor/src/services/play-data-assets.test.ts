import { describe, expect, it } from "vitest";
import { createDataObjectAsset, createDataSheetAsset } from "@babylonslate/core";
import { collectPlayDataCatalog } from "./play-data-assets";

describe("Play data collection", () => {
  it("uses live edits and indexed standalone objects and sheets without reading their files", async () => {
    const entries = await collectPlayDataCatalog([
      { path: "assets/one", header: { guid: "one", type: "DataObject", name: "One", payload: createDataObjectAsset("stats", { Health: 1 }) } },
      { path: "assets/two", header: { guid: "two", type: "DataObject", name: "Two", payload: createDataObjectAsset("stats", { Health: 2 }) } },
      { path: "assets/sheet", header: { guid: "sheet", type: "DataSheet", name: "Sheet", payload: createDataSheetAsset("stats", ["two"]) } },
    ], [
      { ref: { path: "assets/one", kind: "data-object" }, content: createDataObjectAsset("stats", { Health: 9 }) },
    ], async () => { throw new Error("Indexed data must not require per-record file reads."); });
    expect(entries.map((entry) => [entry.guid, entry.payload])).toEqual([
      ["one", { kind: "dataObject", structureGuid: "stats", values: { Health: 9 } }],
      ["two", { kind: "dataObject", structureGuid: "stats", values: { Health: 2 } }],
      ["sheet", { kind: "dataSheet", structureGuid: "stats", objectGuids: ["two"] }],
    ]);
  });

  it("loads incomplete legacy headers and skips placeholders and unreadable records", async () => {
    const entries = await collectPlayDataCatalog([
      { path: "assets/legacy", header: { guid: "legacy", type: "DataObject", name: "Legacy", payload: { structureGuid: "stats" } } },
      { path: "assets/unreadable", header: { guid: "unreadable", type: "DataSheet", name: "Unreadable" } },
      { path: "assets/excluded", placeholder: true, header: { guid: "excluded", type: "DataObject", name: "Excluded" } },
    ], [], async (kind, path) => {
      if (kind === "data-object" && path === "assets/legacy") return createDataObjectAsset("stats", { Health: 8 });
      if (kind === "data-sheet" && path === "assets/unreadable") return null;
      throw new Error("Only incomplete available data assets should be loaded.");
    });
    expect(entries).toEqual([{ guid: "legacy", type: "DataObject", name: "Legacy", payload: { kind: "dataObject", structureGuid: "stats", values: { Health: 8 } } }]);
  });
});
