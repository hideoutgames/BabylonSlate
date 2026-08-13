import { describe, expect, it } from "vitest";
import { createDefaultPlayHud } from "@babylonslate/ui-runtime";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  applyPlayHudInstance,
  asUiDocument,
  playAnimGraphsFromOpenDocuments,
  playUiLibraryFromAssets,
  removePlayHudInstance,
  resolvePlayHudDocuments,
} from "./play-content";

describe("playUiLibraryFromAssets", () => {
  it("indexes UserInterface assets by guid and ignores other types", () => {
    const hud = createDefaultPlayHud("Score");
    hud.widgets.header!.props.text = "Authored";
    const library = playUiLibraryFromAssets(
      [
        {
          guid: "hud-guid",
          path: "assets/HUD.ui.babasset",
          type: "UserInterface",
        },
        {
          guid: "font-guid",
          path: "assets/Display.babasset",
          type: "Font",
        },
      ],
      (path) => (path.endsWith("HUD.ui.babasset") ? hud : null),
    );
    expect(library["hud-guid"]?.widgets.header?.props.text).toBe("Authored");
    expect(library["font-guid"]).toBeUndefined();
  });
});

describe("Play HUD instances", () => {
  it("does not apply any UserInterface until a graph asks", () => {
    expect(resolvePlayHudDocuments([], { "hud-guid": createDefaultPlayHud() })).toEqual(
      [],
    );
  });

  it("applies and removes instances by reference", () => {
    const hud = createDefaultPlayHud("HUD");
    const library = { "hud-guid": hud };
    let instances = applyPlayHudInstance([], "ui-1", "hud-guid");
    instances = applyPlayHudInstance(instances, "ui-2", "hud-guid");
    expect(resolvePlayHudDocuments(instances, library)).toEqual([
      { instanceId: "ui-1", document: hud },
      { instanceId: "ui-2", document: hud },
    ]);
    instances = removePlayHudInstance(instances, "ui-1");
    expect(resolvePlayHudDocuments(instances, library).map((row) => row.instanceId)).toEqual(
      ["ui-2"],
    );
  });

  it("skips instances whose asset is missing from the library", () => {
    expect(
      resolvePlayHudDocuments([{ instanceId: "ui-1", assetGuid: "missing" }], {}),
    ).toEqual([]);
  });
});

describe("asUiDocument", () => {
  it("reads desired size from the payload", () => {
    const doc = asUiDocument({
      name: "Chip",
      rootId: "canvas",
      desiredSize: { width: 240, height: 64 },
      widgets: {},
    });
    expect(doc.desiredSize).toEqual({ width: 240, height: 64 });
  });

  it("falls back desired size to design resolution when omitted", () => {
    const doc = asUiDocument({
      designResolution: { width: 1920, height: 1080 },
      widgets: {},
    });
    expect(doc.desiredSize).toEqual({ width: 1920, height: 1080 });
  });
});

describe("playAnimGraphsFromOpenDocuments", () => {
  it("emits loadAnimGraphs entries keyed by registry guid", () => {
    const graph = createDefaultAnimGraph("Loco");
    const entries = playAnimGraphsFromOpenDocuments(
      [
        {
          id: "anim-graph:assets/Loco.anim.babasset",
          ref: { kind: "anim-graph", path: "assets/Loco.anim.babasset" },
          content: graph,
        },
      ],
      (path) => (path.endsWith("Loco.anim.babasset") ? "graph-guid" : null),
    );
    expect(entries).toEqual([{ guid: "graph-guid", document: graph }]);
  });

  it("skips unparsable documents", () => {
    expect(
      playAnimGraphsFromOpenDocuments(
        [
          {
            id: "anim-graph:assets/Bad.anim.babasset",
            ref: { kind: "anim-graph", path: "assets/Bad.anim.babasset" },
            content: { nope: true },
          },
        ],
        () => "x",
      ),
    ).toEqual([]);
  });
});
