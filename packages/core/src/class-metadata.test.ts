import { describe, expect, it } from "vitest";
import {
  ENGINE_WIDGET_KINDS,
  USER_INTERFACE_CLASS_PREFIX,
  USER_INTERFACE_ENGINE_CLASS_ID,
  WIDGET_ENGINE_CLASS_ID,
  isUserInterfaceClassId,
  isWidgetClassId,
  normalizeUserInterfaceClassRef,
  userInterfaceAssetGuidFromClassId,
  userInterfaceClassId,
  userInterfaceClassMetadata,
  widgetClassIdForKind,
  widgetKindFromClassId,
} from "./class-metadata";

describe("UserInterface class ids", () => {
  it("derives a namespaced class id from the asset guid, not a filename", () => {
    expect(userInterfaceClassId("hud-guid-1")).toBe(
      `${USER_INTERFACE_CLASS_PREFIX}hud-guid-1`,
    );
    expect(userInterfaceClassId("hud-guid-1")).not.toBe("HUD");
    expect(userInterfaceClassId("hud-guid-1")).not.toContain(".ui.babasset");
  });

  it("keeps two same-named assets distinct and survives rename", () => {
    const menuA = userInterfaceClassId("guid-menu-a");
    const menuB = userInterfaceClassId("guid-menu-b");
    expect(menuA).not.toBe(menuB);
    expect(menuA).toBe(userInterfaceClassId("guid-menu-a"));
  });

  it("round-trips the asset guid and rejects path-derived ids", () => {
    const classId = userInterfaceClassId("asset-9");
    expect(isUserInterfaceClassId(classId)).toBe(true);
    expect(userInterfaceAssetGuidFromClassId(classId)).toBe("asset-9");
    expect(isUserInterfaceClassId("HUD")).toBe(false);
    expect(isUserInterfaceClassId("UserInterface")).toBe(false);
    expect(userInterfaceAssetGuidFromClassId("HUD")).toBeNull();
    expect(userInterfaceAssetGuidFromClassId("UserInterface")).toBeNull();
  });

  it("builds compile metadata that parent UserInterface, not Actor", () => {
    expect(userInterfaceClassMetadata("guid-hud")).toEqual({
      classId: "UserInterface:guid-hud",
      parentClassId: USER_INTERFACE_ENGINE_CLASS_ID,
      assetGuid: "guid-hud",
    });
  });

  it("normalizes a raw asset guid or already-namespaced class ref", () => {
    expect(normalizeUserInterfaceClassRef("guid-hud")).toBe(
      "UserInterface:guid-hud",
    );
    expect(normalizeUserInterfaceClassRef("UserInterface:guid-hud")).toBe(
      "UserInterface:guid-hud",
    );
    expect(normalizeUserInterfaceClassRef("  ")).toBeNull();
    expect(normalizeUserInterfaceClassRef(null)).toBeNull();
  });
});

describe("Widget class ids", () => {
  it("maps Button and Image to concrete subclasses", () => {
    expect(widgetClassIdForKind("Button")).toBe("ButtonWidget");
    expect(widgetClassIdForKind("Image")).toBe("ImageWidget");
    expect(widgetKindFromClassId("ButtonWidget")).toBe("Button");
    expect(widgetKindFromClassId("ImageWidget")).toBe("Image");
  });

  it("maps every engine widget kind deterministically", () => {
    const classIds = ENGINE_WIDGET_KINDS.map((kind) => widgetClassIdForKind(kind));
    expect(new Set(classIds).size).toBe(ENGINE_WIDGET_KINDS.length);
    for (const kind of ENGINE_WIDGET_KINDS) {
      const classId = widgetClassIdForKind(kind);
      expect(classId.endsWith("Widget")).toBe(true);
      expect(isWidgetClassId(classId)).toBe(true);
      expect(widgetKindFromClassId(classId)).toBe(kind);
    }
    expect(isWidgetClassId(WIDGET_ENGINE_CLASS_ID)).toBe(true);
    expect(isWidgetClassId("WidgetComponent")).toBe(false);
    expect(isWidgetClassId("UserInterface")).toBe(false);
    expect(isWidgetClassId("UserInterface:guid-1")).toBe(false);
  });
});
