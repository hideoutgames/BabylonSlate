import { describe, expect, it } from "vitest";
import {
  parseRichText,
  parseRichTextColor,
  richTextCustomEffectNames,
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
});

describe("custom effect tags", () => {
  it("applies fx Classes by name with a strength, nests them and leaves the built-in effects alone", () => {
    const spans = parseRichText("a[fx=Bounce]b[fx=Wobble strength=2.5]c[fx=Bounce strength=x]d[/fx][/fx][shake=2]e[/shake][/fx]f[fx]g[/fx]", defaults);
    expect(spans.map((span) => span.kind === "text" ? [span.text, span.effects.custom ?? null, span.effects.shake] : null)).toEqual([
      ["a", null, 0],
      ["b", [{ name: "Bounce", strength: 1, attrs: {} }], 0],
      ["c", [{ name: "Bounce", strength: 1, attrs: {} }, { name: "Wobble", strength: 2.5, attrs: { strength: "2.5" } }], 0],
      // A repeated name keeps its place and takes the inner tag's values; a strength that is not a number is 1.
      ["d", [{ name: "Bounce", strength: 1, attrs: { strength: "x" } }, { name: "Wobble", strength: 2.5, attrs: { strength: "2.5" } }], 0],
      ["e", [{ name: "Bounce", strength: 1, attrs: {} }], 2],
      // A tag without a Class name applies nothing.
      ["fg", null, 0],
    ]);
    expect(richTextCustomEffectNames("[fx=Wobble]a[/fx][fx=Bounce]b[fx=Wobble]c[/fx][/fx]")).toEqual(["Wobble", "Bounce"]);
  });

  it("keeps every keyword of an fx tag as text, keys lower-cased, and splits runs only where the values differ", () => {
    const spans = parseRichText("[fx=Wave Speed=2 height=4.5 mood=calm]ab[/fx][fx=Wave height=4.5 speed=2 mood=calm]c[/fx][fx=Wave speed=3]d[/fx]", defaults);
    expect(spans.map((span) => span.kind === "text" ? [span.text, span.effects.custom ?? null] : null)).toEqual([
      // The same keywords in another order continue the run.
      ["abc", [{ name: "Wave", strength: 1, attrs: { speed: "2", height: "4.5", mood: "calm" } }]],
      ["d", [{ name: "Wave", strength: 1, attrs: { speed: "3" } }]],
    ]);
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
