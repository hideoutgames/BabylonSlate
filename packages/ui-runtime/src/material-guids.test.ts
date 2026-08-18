import { describe, expect, it } from "vitest";
import { createDefaultUserInterface, createWidget } from "./types";
import { collectMaterialGuidsFromUiDocuments } from "./material-guids";

describe("collectMaterialGuidsFromUiDocuments", () => {
  it("collects materialGuid from Material widgets across documents", () => {
    const hud = createDefaultUserInterface("HUD");
    const glow = createWidget("glow", "Material", "Glow");
    glow.props.materialGuid = "mat-glow";
    hud.widgets.canvas!.children = ["glow"];
    hud.widgets.glow = glow;

    const panel = createDefaultUserInterface("Panel");
    const wash = createWidget("wash", "Material", "Wash");
    wash.props.materialGuid = "mat-wash";
    panel.widgets.canvas!.children = ["wash"];
    panel.widgets.wash = wash;

    expect(collectMaterialGuidsFromUiDocuments([hud, panel]).sort()).toEqual([
      "mat-glow",
      "mat-wash",
    ]);
  });

  it("collects materialGuid from nested UserInterface documents", () => {
    const chip = createDefaultUserInterface("Chip");
    const fx = createWidget("fx", "Material", "Fx");
    fx.props.materialGuid = "mat-nested";
    chip.widgets.canvas!.children = ["fx"];
    chip.widgets.fx = fx;

    const hud = createDefaultUserInterface("HUD");
    const host = createWidget("chip", "UserInterface", "Chip");
    host.nestedUiGuid = "chip-guid";
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = host;

    expect(
      collectMaterialGuidsFromUiDocuments([hud], (guid) =>
        guid === "chip-guid" ? chip : null,
      ),
    ).toEqual(["mat-nested"]);
  });
});
