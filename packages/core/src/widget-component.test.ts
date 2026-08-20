import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_HEIGHT,
  DEFAULT_WIDGET_WIDTH,
  createWidgetComponent,
  parseWidgetComponentProperties,
  parseWidgetHeight,
  parseWidgetTwoSided,
  parseWidgetUiAssetGuid,
  parseWidgetWidth,
  widgetUiGuidsFromScene,
} from "./widget-component";
import { createActor } from "./scene";
import { createDefaultScene } from "./project";

describe("WidgetComponent helpers", () => {
  it("creates a Widget component with engine defaults", () => {
    const component = createWidgetComponent("widget-1");
    expect(component.classId).toBe("WidgetComponent");
    expect(component.properties).toEqual({
      uiAssetGuid: null,
      twoSided: false,
      width: DEFAULT_WIDGET_WIDTH,
      height: DEFAULT_WIDGET_HEIGHT,
    });
    expect(component.properties).not.toHaveProperty("viewportLayer");
    expect(parseWidgetTwoSided(undefined)).toBe(false);
    expect(parseWidgetWidth(-2)).toBe(1);
    expect(parseWidgetHeight(0)).toBe(1);
    expect(parseWidgetUiAssetGuid("")).toBeNull();
  });

  it("parses authored properties, ignores viewportLayer, and collects UI guids", () => {
    const parsed = parseWidgetComponentProperties({
      uiAssetGuid: "hud-1",
      twoSided: true,
      width: 2,
      height: 0.5,
      viewportLayer: true,
    });
    expect(parsed).toEqual({
      uiAssetGuid: "hud-1",
      twoSided: true,
      width: 2,
      height: 0.5,
    });
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("sign", "Sign", {
        components: [
          createWidgetComponent("w1"),
          {
            ...createWidgetComponent("w2"),
            properties: {
              ...createWidgetComponent("w2").properties,
              uiAssetGuid: "panel-ui",
            },
          },
        ],
      }),
    );
    expect(widgetUiGuidsFromScene(scene)).toEqual(["panel-ui"]);
  });
});
