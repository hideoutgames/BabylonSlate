import { describe, expect, it } from "vitest";
import {
  DEFAULT_RICH_TEXT_EXAMPLE,
  parseRichText,
  parseRichTextColor,
  richTextImageGuids,
  type ParseRichTextDefaults,
} from "./rich-text";

const defaults: ParseRichTextDefaults = {
  bold: false,
  italic: false,
  underline: false,
  color: [1, 1, 1],
  size: 32,
  outline: 0,
  outlineColor: [0, 0, 0],
};

describe("parseRichTextColor", () => {
  it("parses named CSS colors and optional-hash hex including 4-digit RGBA", () => {
    expect(parseRichTextColor("green")).toEqual([0, 128 / 255, 0]);
    expect(parseRichTextColor("FFFF")).toEqual([1, 1, 1]);
    expect(parseRichTextColor("#ff0000")).toEqual([1, 0, 0]);
    expect(parseRichTextColor("orange")).toEqual([1, 165 / 255, 0]);
    expect(parseRichTextColor("not-a-color")).toBeNull();
  });
});

describe("parseRichText", () => {
  it("keeps unknown tags as literal text", () => {
    const spans = parseRichText("Hello [unknown]world", defaults);
    expect(spans).toEqual([
      {
        kind: "text",
        text: "Hello [unknown]world",
        style: expect.objectContaining({ color: [1, 1, 1], size: 32 }),
        effects: expect.objectContaining({ shake: 0, rotate: 0 }),
      },
    ]);
  });

  it("nests color, bold, shake, rotate, and inline images", () => {
    const spans = parseRichText(
      "[color=green]Hello [b]this [img=tex-guid size=14] image[/b] has a [rotate=45]custom [b][shake=1]size[/shake][/rotate] and this one does [/color][color=FFFF]not[/color]",
      defaults,
    );
    const texts = spans
      .filter((span) => span.kind === "text")
      .map((span) => span.text);
    expect(texts.join("")).toBe(
      "Hello this  image has a custom size and this one does not",
    );
    const image = spans.find((span) => span.kind === "image");
    expect(image).toMatchObject({
      kind: "image",
      guid: "tex-guid",
      size: 14,
    });
    expect(image?.style.bold).toBe(true);
    expect(image?.style.color).toEqual([0, 128 / 255, 0]);
    const shaken = spans.find(
      (span) => span.kind === "text" && span.text === "size",
    );
    expect(shaken?.effects.shake).toBe(1);
    expect(shaken?.effects.rotate).toBe(45);
    expect(shaken?.style.bold).toBe(true);
    const notSpan = spans.find(
      (span) => span.kind === "text" && span.text === "not",
    );
    expect(notSpan?.style.color).toEqual([1, 1, 1]);
  });

  it("stacks wave hover and outline onto later text and applies unclosed tags to the end", () => {
    const spans = parseRichText(
      "[wave=2 intensity=0.5][hover=1][outline=2][outline-color=red]Hi",
      defaults,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      kind: "text",
      text: "Hi",
      style: {
        outline: 2,
        outlineColor: [1, 0, 0],
      },
      effects: {
        waveSpeed: 2,
        waveIntensity: 0.5,
        hover: 1,
      },
    });
  });

  it("uses current font size for images without size and default wave intensity 1", () => {
    const spans = parseRichText(
      "[size=20][img=abc][wave=3]W[/wave]",
      defaults,
    );
    expect(spans[0]).toMatchObject({
      kind: "image",
      guid: "abc",
      size: 20,
    });
    const wave = spans.find((span) => span.kind === "text" && span.text === "W");
    expect(wave?.effects.waveSpeed).toBe(3);
    expect(wave?.effects.waveIntensity).toBe(1);
  });

  it("seeds the documented example string", () => {
    expect(DEFAULT_RICH_TEXT_EXAMPLE).toContain("[color=green]");
    expect(DEFAULT_RICH_TEXT_EXAMPLE).toContain("[img=PASTE_TEXTURE_GUID size=14]");
    expect(DEFAULT_RICH_TEXT_EXAMPLE).toContain("[shake=1]");
    expect(DEFAULT_RICH_TEXT_EXAMPLE).toContain("[rotate=45]");
    expect(DEFAULT_RICH_TEXT_EXAMPLE).toContain("[color=FFFF]");
  });
});

describe("richTextImageGuids", () => {
  it("collects unique image guids from markup", () => {
    expect(
      richTextImageGuids(
        "[img=one] x [img=one size=8] [img=two] [img=PASTE_TEXTURE_GUID]",
      ),
    ).toEqual(["one", "two", "PASTE_TEXTURE_GUID"]);
  });
});
