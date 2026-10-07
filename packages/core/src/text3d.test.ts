import { describe, expect, it } from "vitest";
import {
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
  it("falls back to engine defaults for invalid 3D Text properties", () => {
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
