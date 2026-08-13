import { describe, expect, it } from "vitest";
import { createDefaultPlayHud } from "@babylonslate/ui-runtime";
import { createDefaultAnimGraph } from "@babylonslate/anim-graph";
import {
  asUiDocument,
  playAnimGraphsFromOpenDocuments,
  playHudFromOpenDocuments,
} from "./play-content";

describe("playHudFromOpenDocuments", () => {
  it("falls back to the default HUD when no UserInterface is open", () => {
    const hud = playHudFromOpenDocuments([], null);
    expect(hud.widgets.stick?.kind).toBe("TouchJoystick");
    expect(hud.name).toBe(createDefaultPlayHud("HUD").name);
  });

  it("hosts the active viewport-layer UserInterface", () => {
    const authored = createDefaultPlayHud("Score");
    authored.widgets.header!.props.text = "Authored";
    const hud = playHudFromOpenDocuments(
      [
        {
          id: "ui:assets/HUD.ui.babasset",
          ref: { kind: "ui", path: "assets/HUD.ui.babasset" },
          content: authored,
        },
      ],
      "ui:assets/HUD.ui.babasset",
    );
    expect(hud.widgets.header?.props.text).toBe("Authored");
  });

  it("skips a non-viewport-layer UI", () => {
    const world = asUiDocument(createDefaultPlayHud("World"));
    world.viewportLayer = false;
    const hud = playHudFromOpenDocuments(
      [
        {
          id: "ui:assets/World.ui.babasset",
          ref: { kind: "ui", path: "assets/World.ui.babasset" },
          content: world,
        },
      ],
      "ui:assets/World.ui.babasset",
    );
    expect(hud.widgets.header?.props.text).toBe("Score");
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
