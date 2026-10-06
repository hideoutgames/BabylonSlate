import { describe, expect, it } from "vitest";
import { createDataTreeAsset, createDataTreeEntry } from "@babylonslate/core";
import { collectPlayDataCatalog } from "./play-data-assets";

describe("Play data collection", () => {
  it("uses live tree edits and indexed Definitions and trees without per-entry file reads", async () => {
    const definition = { kind: "dataDefinition", fields: [{ id: "health", name: "Health", typeId: "int" }] };
    const indexed = createDataTreeAsset("stats", [createDataTreeEntry({ id: "one", name: "One", values: { Health: 1 } })]);
    const live = createDataTreeAsset("stats", [createDataTreeEntry({ id: "one", name: "One Renamed", values: { Health: 9 } })]);
    const entries = await collectPlayDataCatalog([
      { path: "assets/stats", header: { guid: "stats", type: "DataDefinition", name: "Stats", payload: definition } },
      { path: "assets/tree", header: { guid: "tree", type: "DataTree", name: "Tree", payload: indexed } },
      { path: "assets/empty", header: { guid: "empty", type: "DataTree", name: "Empty", payload: createDataTreeAsset("stats") } },
    ], [
      { ref: { path: "assets/tree", kind: "data-tree" }, content: live },
    ], async () => { throw new Error("Indexed data must not require per-entry file reads."); });
    expect(entries.map((entry) => [entry.guid, entry.payload])).toEqual([
      ["stats", definition], ["tree", live], ["empty", createDataTreeAsset("stats")],
    ]);
  });

  it("loads incomplete indexed headers and skips placeholders and unreadable trees", async () => {
    const loaded = createDataTreeAsset("stats", [createDataTreeEntry({ id: "entry", name: "Entry", values: { Health: 8 } })]);
    const entries = await collectPlayDataCatalog([
      { path: "assets/incomplete", header: { guid: "incomplete", type: "DataTree", name: "Incomplete", payload: { defaultDefinitionGuid: "stats" } } },
      { path: "assets/unreadable", header: { guid: "unreadable", type: "DataTree", name: "Unreadable" } },
      { path: "assets/excluded", placeholder: true, header: { guid: "excluded", type: "DataDefinition", name: "Excluded" } },
    ], [], async (kind, path) => {
      if (kind === "data-tree" && path === "assets/incomplete") return loaded;
      if (kind === "data-tree" && path === "assets/unreadable") return null;
      throw new Error("Only incomplete available data assets should be loaded.");
    });
    expect(entries).toEqual([{ guid: "incomplete", type: "DataTree", name: "Incomplete", payload: loaded }]);
  });
});
