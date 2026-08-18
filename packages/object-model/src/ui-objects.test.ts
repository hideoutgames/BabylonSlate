import { describe, expect, it } from "vitest";
import { BObject } from "./objects";
import {
  ButtonWidget,
  ImageWidget,
  UserInterface,
  Widget,
  createWidgetForKind,
  widgetClassForKind,
} from "./ui-objects";

describe("UserInterface and Widget objects", () => {
  it("constructs a UserInterface as a BObject with an asset guid", () => {
    const ui = new UserInterface({
      classId: "UserInterface:hud-1",
      guid: "inst-1",
      assetGuid: "hud-1",
    });
    expect(ui).toBeInstanceOf(BObject);
    expect(ui).not.toBeInstanceOf(Widget);
    expect(ui.classId).toBe("UserInterface:hud-1");
    expect(ui.assetGuid).toBe("hud-1");
    expect(ui.widgets).toEqual([]);
  });

  it("scopes a Widget to an owning UserInterface instance", () => {
    const ui = new UserInterface({
      classId: "UserInterface:hud-1",
      guid: "inst-1",
      assetGuid: "hud-1",
    });
    const button = new ButtonWidget({
      classId: "ButtonWidget",
      guid: "w-1",
      widgetId: "play-btn",
      owner: ui,
    });
    expect(button).toBeInstanceOf(Widget);
    expect(button).toBeInstanceOf(BObject);
    expect(button.widgetId).toBe("play-btn");
    expect(button.owner).toBe(ui);
    expect(button.classId).toBe("ButtonWidget");
  });

  it("maps every widget kind to a concrete Widget subclass", () => {
    expect(widgetClassForKind("Button")).toBe(ButtonWidget);
    expect(widgetClassForKind("Image")).toBe(ImageWidget);
    const image = createWidgetForKind("Image", {
      classId: "ImageWidget",
      guid: "w-2",
      widgetId: "logo",
    });
    expect(image).toBeInstanceOf(ImageWidget);
    expect(image.widgetId).toBe("logo");
    expect(image.owner).toBeNull();
    const unknown = createWidgetForKind("NotAKind", {
      classId: "Widget",
      guid: "w-3",
      widgetId: "x",
    });
    expect(unknown).toBeInstanceOf(Widget);
    expect(unknown).not.toBeInstanceOf(ButtonWidget);
  });
});
