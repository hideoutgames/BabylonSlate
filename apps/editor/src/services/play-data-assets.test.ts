import { describe, expect, it } from "vitest";
import { createDataSheetAsset } from "@babylonslate/core";
import { collectPlayDataCatalog } from "./play-data-assets";

describe("Play data collection", () => {
  it("uses live sheet edits and indexed Definitions and sheets without per-row file reads", async () => {
    const definition = { kind: "dataDefinition", fields: [{ id: "health", name: "Health", typeId: "int" }] };
    const indexed = createDataSheetAsset("stats", [{ id: "one", name: "One", values: { Health: 1 } }]);
    const live = createDataSheetAsset("stats", [{ id: "one", name: "One renamed", values: { Health: 9 } }]);
    const entries = await collectPlayDataCatalog([
      { path: "assets/stats", header: { guid: "stats", type: "DataDefinition", name: "Stats", payload: definition } },
      { path: "assets/sheet", header: { guid: "sheet", type: "DataSheet", name: "Sheet", payload: indexed } },
      { path: "assets/empty", header: { guid: "empty", type: "DataSheet", name: "Empty", payload: createDataSheetAsset("stats") } },
    ], [
      { ref: { path: "assets/sheet", kind: "data-sheet" }, content: live },
    ], async () => { throw new Error("Indexed data must not require per-row file reads."); });
    expect(entries.map((entry) => [entry.guid, entry.payload])).toEqual([
      ["stats", definition], ["sheet", live], ["empty", createDataSheetAsset("stats")],
    ]);
  });

  it("loads incomplete indexed headers and skips placeholders and unreadable sheets", async () => {
    const loaded = createDataSheetAsset("stats", [{ id: "row", name: "Row", values: { Health: 8 } }]);
    const entries = await collectPlayDataCatalog([
      { path: "assets/incomplete", header: { guid: "incomplete", type: "DataSheet", name: "Incomplete", payload: { definitionGuid: "stats" } } },
      { path: "assets/unreadable", header: { guid: "unreadable", type: "DataSheet", name: "Unreadable" } },
      { path: "assets/excluded", placeholder: true, header: { guid: "excluded", type: "DataDefinition", name: "Excluded" } },
    ], [], async (kind, path) => {
      if (kind === "data-sheet" && path === "assets/incomplete") return loaded;
      if (kind === "data-sheet" && path === "assets/unreadable") return null;
      throw new Error("Only incomplete available data assets should be loaded.");
    });
    expect(entries).toEqual([{ guid: "incomplete", type: "DataSheet", name: "Incomplete", payload: loaded }]);
  });
});
