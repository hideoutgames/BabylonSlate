import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT3D_ALIGNMENT,
  DEFAULT_TEXT3D_COLOR,
  DEFAULT_TEXT3D_DEPTH,
  DEFAULT_TEXT3D_SIZE,
  DEFAULT_TEXT3D_TEXT,
  TEXT3D_ALIGNMENTS,
  createText3DComponent,
  parseText3DAlignment,
  parseText3DColor,
  parseText3DDepth,
  parseText3DFontAssetGuid,
  parseText3DProperties,
  parseText3DSize,
  parseText3DText,
  text3DFontGuidsFromScene,
} from "./text3d";
import { createActor } from "./scene";
import { createDefaultScene } from "./project";

describe("Text3DComponent helpers", () => {
  it("creates a 3D Text component with engine defaults", () => {
    const component = createText3DComponent("text-1");
    expect(component.classId).toBe("Text3DComponent");
    expect(component.properties).toEqual({
      text: DEFAULT_TEXT3D_TEXT,
      size: DEFAULT_TEXT3D_SIZE,
      depth: DEFAULT_TEXT3D_DEPTH,
      color: DEFAULT_TEXT3D_COLOR,
      fontAssetGuid: null,
      alignment: DEFAULT_TEXT3D_ALIGNMENT,
    });
    expect(TEXT3D_ALIGNMENTS).toEqual(["left", "center", "right"]);
    expect(parseText3DAlignment(undefined)).toBe("left");
    expect(parseText3DAlignment("right")).toBe("right");
    expect(parseText3DAlignment("nope")).toBe("left");
    expect(parseText3DText(undefined)).toBe("Text");
    expect(parseText3DSize(-2)).toBe(1);
    expect(parseText3DDepth(0)).toBe(0.1);
    expect(parseText3DColor(undefined)).toEqual([1, 1, 1]);
    expect(parseText3DFontAssetGuid("")).toBeNull();
  });

  it("parses authored properties and collects Font guids from a scene", () => {
    const parsed = parseText3DProperties({
      text: "Hi",
      size: 2,
      depth: 0.25,
      color: [0.2, 0.4, 0.6],
      fontAssetGuid: "font-1",
      alignment: "center",
    });
    expect(parsed).toEqual({
      text: "Hi",
      size: 2,
      depth: 0.25,
      color: [0.2, 0.4, 0.6],
      fontAssetGuid: "font-1",
      alignment: "center",
    });
    expect(parseText3DProperties({}).alignment).toBe("left");
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("label", "Label", {
        components: [
          createText3DComponent("t1"),
          {
            ...createText3DComponent("t2"),
            properties: {
              ...createText3DComponent("t2").properties,
              fontAssetGuid: "font-display",
            },
          },
        ],
      }),
    );
    expect(text3DFontGuidsFromScene(scene)).toEqual(["font-display"]);
  });
});
