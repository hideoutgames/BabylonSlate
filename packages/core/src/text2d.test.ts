import { describe, expect, it } from "vitest";
import { createActor } from "./scene";
import { createDefaultScene } from "./project";
import {
  DEFAULT_RICH_TEXT_EXAMPLE,
  DEFAULT_TEXT2D_SIZE,
  DEFAULT_TEXT2D_WRAP_HEIGHT,
  DEFAULT_TEXT2D_WRAP_WIDTH,
  TEXT2D_ALIGNMENTS,
  TEXT2D_VERTICAL_ALIGNMENTS,
  TEXT2D_RENDERERS,
  createRichText2DComponent,
  createText2DComponent,
  parseText2DProperties,
  resolveText2DRenderer,
  text2dFontGuidsFromScene,
  text2dImageGuidsFromScene,
  text2dMsdfDescription,
  text2dMsdfStatus,
} from "./text2d";

describe("2DTextComponent helpers", () => {
  it("creates overlay text with bitmap defaults and ignore HitTest", () => {
    const component = createText2DComponent("t1");
    expect(component.classId).toBe("2DTextComponent");
    expect(component.properties).toEqual({
      text: "Text",
      fontAssetGuid: null,
      size: DEFAULT_TEXT2D_SIZE,
      color: [1, 1, 1],
      renderer: "bitmap",
      outline: 0,
      outlineColor: [0, 0, 0],
      alignment: "left",
      verticalAlignment: "center",
      bold: false,
      italic: false,
      underline: false,
      hitTest: "ignore",
      wrapWidth: DEFAULT_TEXT2D_WRAP_WIDTH,
      wrapHeight: DEFAULT_TEXT2D_WRAP_HEIGHT,
    });
    expect(TEXT2D_RENDERERS).toEqual(["bitmap", "msdf"]);
    expect(TEXT2D_ALIGNMENTS).toEqual(["left", "center", "right"]);
    expect(TEXT2D_VERTICAL_ALIGNMENTS).toEqual(["top", "center", "bottom"]);
    expect(
      parseText2DProperties({ size: -1, renderer: "nope" }),
    ).toMatchObject({
      size: 32,
      renderer: "bitmap",
      hitTest: "ignore",
      wrapWidth: 0,
      wrapHeight: 0,
      verticalAlignment: "center",
    });
  });

  it("seeds 2D Rich Text with the markup example", () => {
    const component = createRichText2DComponent("rt1");
    expect(component.classId).toBe("2DRichTextComponent");
    expect(component.properties.text).toBe(DEFAULT_RICH_TEXT_EXAMPLE);
  });

  it("collects Font and inline image guids from overlay text components", () => {
    const scene = createDefaultScene();
    scene.actors.push(
      createActor("hud", "Hud", {
        components: [
          createText2DComponent("plain"),
          {
            ...createRichText2DComponent("rich"),
            properties: {
              ...createRichText2DComponent("rich").properties,
              fontAssetGuid: "font-display",
              text: "[img=tex-a]Hi[img=tex-a][img=tex-b]",
            },
          },
        ],
      }),
    );
    expect(text2dFontGuidsFromScene(scene)).toEqual(["font-display"]);
    expect(text2dImageGuidsFromScene(scene)).toEqual(["tex-a", "tex-b"]);
  });

  it("coerces MSDF to bitmap when the Font pair is missing", () => {
    expect(resolveText2DRenderer("msdf", true)).toBe("msdf");
    expect(resolveText2DRenderer("msdf", false)).toBe("bitmap");
    expect(resolveText2DRenderer("bitmap", true)).toBe("bitmap");
  });

  it("explains why MSDF is unavailable on a Font", () => {
    expect(text2dMsdfStatus(null, { json: false, png: false })).toBe("no-font");
    expect(text2dMsdfStatus("font-1", { json: false, png: false })).toBe("none");
    expect(text2dMsdfStatus("font-1", { json: true, png: false })).toBe("json-only");
    expect(text2dMsdfStatus("font-1", { json: false, png: true })).toBe("png-only");
    expect(text2dMsdfStatus("font-1", { json: true, png: true })).toBe("ready");
    expect(text2dMsdfDescription("no-font")).toContain("Pick a Font");
    expect(text2dMsdfDescription("json-only")).toContain("no atlas PNG");
  });
});
