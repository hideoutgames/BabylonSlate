import { describe, expect, it } from "vitest";
import {
  collectFontAssetEntries,
  collectFontFacetypeBytes,
  collectFontMsdfPair,
  fontAssetHasMsdfJson,
  fontAssetHasMsdfPair,
  fontAssetHasMsdfPng,
} from "./play-fonts";

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
    const source = entries[0]!.bytes;
    const view =
      source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    expect(view).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("loads facetype-glyphs chunks for requested Font guids", async () => {
    const bytes = await collectFontFacetypeBytes(
      [
        {
          guid: "font-1",
          path: "assets/Display.font.babasset",
          type: "Font",
        },
        {
          guid: "font-2",
          path: "assets/Body.font.babasset",
          type: "Font",
        },
        {
          guid: "tex-1",
          path: "assets/Icon.texture.babasset",
          type: "Texture",
        },
      ],
      ["font-1", "tex-1"],
      async (path, chunkId) => {
        if (path.includes("Display") && chunkId === "facetype-glyphs") {
          return new Uint8Array([9, 8, 7]);
        }
        if (path.includes("Body") && chunkId === "facetype-glyphs") {
          return new Uint8Array([1]);
        }
        return null;
      },
    );
    expect([...bytes.keys()]).toEqual(["font-1"]);
    expect(bytes.get("font-1")).toEqual(new Uint8Array([9, 8, 7]));
  });
});

describe("collectFontMsdfPair", () => {
  it("loads JSON and PNG chunks only when both exist", async () => {
    const pairs = await collectFontMsdfPair(
      [
        {
          guid: "font-1",
          path: "assets/Display.font.babasset",
          type: "Font",
        },
        {
          guid: "font-2",
          path: "assets/Body.font.babasset",
          type: "Font",
        },
      ],
      ["font-1", "font-2"],
      async (path, chunkId) => {
        if (path.includes("Display") && chunkId === "msdf-atlas") {
          return new Uint8Array([1, 2]);
        }
        if (path.includes("Display") && chunkId === "msdf-atlas-png") {
          return new Uint8Array([3, 4]);
        }
        if (path.includes("Body") && chunkId === "msdf-atlas") {
          return new Uint8Array([9]);
        }
        return null;
      },
    );
    expect([...pairs.keys()]).toEqual(["font-1"]);
    expect(pairs.get("font-1")?.json).toEqual(new Uint8Array([1, 2]));
    expect(pairs.get("font-1")?.png).toEqual(new Uint8Array([3, 4]));
  });
});

describe("font MSDF representation flags", () => {
  it("reads JSON and PNG flags independently and only pairs when both are set", () => {
    const payload = {
      representations: { msdfJson: true, msdfPng: false },
    };
    expect(fontAssetHasMsdfJson(payload)).toBe(true);
    expect(fontAssetHasMsdfPng(payload)).toBe(false);
    expect(fontAssetHasMsdfPair(payload)).toBe(false);
    expect(
      fontAssetHasMsdfPair({
        representations: { msdfJson: true, msdfPng: true },
      }),
    ).toBe(true);
  });
});
