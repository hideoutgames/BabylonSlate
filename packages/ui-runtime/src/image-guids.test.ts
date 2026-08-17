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

  it("collects imageGuid from nested UserInterface documents", () => {
    const chip = createDefaultUserInterface("Chip");
    const art = createWidget("art", "Image", "Art");
    art.props.imageGuid = "tex-nested";
    chip.widgets.canvas!.children = ["art"];
    chip.widgets.art = art;

    const hud = createDefaultUserInterface("HUD");
    const host = createWidget("chip", "UserInterface", "Chip");
    host.nestedUiGuid = "chip-guid";
    hud.widgets.canvas!.children = ["chip"];
    hud.widgets.chip = host;

    expect(
      collectImageGuidsFromUiDocuments([hud], (guid) =>
        guid === "chip-guid" ? chip : null,
      ),
    ).toEqual(["tex-nested"]);
  });
});
