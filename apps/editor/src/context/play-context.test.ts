import { describe, expect, it } from "vitest";
import { createDefaultUserInterface, createWidget } from "@babylonslate/ui-runtime";
import { playSessionUiOptions } from "./play-context";

describe("playSessionUiOptions", () => {
  it("ships widget metadata plus the full document and never auto-applies instances", () => {
    const hud = createDefaultUserInterface("HUD");
    hud.widgets.canvas!.children = ["play-btn"];
    hud.widgets["play-btn"] = createWidget("play-btn", "Button", "Play");
    const options = playSessionUiOptions({ "hud-guid": hud });
    expect(options.userInterfaces).toEqual([
      {
        guid: "hud-guid",
        widgets: expect.arrayContaining([
          { id: "canvas", kind: "Canvas", name: "Canvas" },
          { id: "play-btn", kind: "Button", name: "Play" },
        ]),
        document: hud,
      },
    ]);
    expect(options.autoApply).toBe(false);
  });
});
