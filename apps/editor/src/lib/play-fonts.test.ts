import { describe, expect, it } from "vitest";
import { collectFontAssetEntries } from "./play-fonts";

describe("collectFontAssetEntries", () => {
  it("loads source bytes for Font assets and skips empty chunks", async () => {
    const entries = await collectFontAssetEntries(
      [
        {
          guid: "font-1",
          path: "assets/Display.font.babasset",
          type: "Font",
          payload: { family: "Display Face", weight: 700, style: "italic" },
        },
        {
          guid: "font-empty",
          path: "assets/Empty.font.babasset",
          type: "Font",
          payload: { family: "Empty" },
        },
        {
          guid: "tex-1",
          path: "assets/Icon.texture.babasset",
          type: "Texture",
          payload: {},
        },
      ],
      async (path) => {
        if (path.includes("Display")) return new Uint8Array([1, 2, 3]);
        return new Uint8Array();
      },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.guid).toBe("font-1");
    expect(entries[0]?.family).toBe("Display Face");
    expect(entries[0]?.weight).toBe(700);
    expect(entries[0]?.style).toBe("italic");
    expect(new Uint8Array(entries[0]!.bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
