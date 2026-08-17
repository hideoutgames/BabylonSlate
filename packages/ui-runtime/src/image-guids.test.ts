import { describe, expect, it } from "vitest";
import { createDefaultUserInterface, createWidget } from "./types";
import { collectImageGuidsFromUiDocuments } from "./image-guids";

describe("collectImageGuidsFromUiDocuments", () => {
  it("collects imageGuid from widget props and style across documents", () => {
    const hud = createDefaultUserInterface("HUD");
    const logo = createWidget("logo", "Image", "Logo");
    logo.props.imageGuid = "tex-logo";
    hud.widgets.canvas!.children = ["logo"];
    hud.widgets.logo = logo;

    const panel = createDefaultUserInterface("Panel");
    const icon = createWidget("icon", "Image", "Icon");
    icon.style.imageGuid = "tex-icon";
    panel.widgets.canvas!.children = ["icon"];
    panel.widgets.icon = icon;

    expect(collectImageGuidsFromUiDocuments([hud, panel]).sort()).toEqual([
      "tex-icon",
      "tex-logo",
    ]);
  });
});
