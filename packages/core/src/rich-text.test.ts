import { describe, expect, it } from "vitest";
import {
  expandRichTextTags,
  parseRichText,
  parseRichTextColor,
  richTextCustomEffectNames,
  richTextImageGuids,
  type ParseRichTextDefaults,
  type RichTextTagDecoration,
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

describe("expandRichTextTags", () => {
  /** Expands with markup from `handlers` by tag, recording every decoration in `calls`; a missing handler is null. */
  function expand(source: string, handlers: Record<string, (decoration: RichTextTagDecoration) => string | null>) {
    const calls: RichTextTagDecoration[] = [];
    const text = expandRichTextTags(source, new Set(Object.keys(handlers)), (decoration) => {
      calls.push(decoration);
      return handlers[decoration.tag]!(decoration);
    });
    return { text, calls };
  }
  const player = () => "Ada";

  it("returns the source itself without calling anything when there are no custom tags, or none in the text", () => {
    const source = "[b]Hi[/b] [player [img=x]";
    expect(expandRichTextTags(source, new Set(), () => { throw new Error("no call"); })).toBe(source);
    const { text, calls } = expand(source, { hero: player });
    expect(text).toBe(source);
    expect(calls).toEqual([]);
  });

  it("replaces a tag with no closing tag alone, matching its name in any case", () => {
    expect(expand("Hi [player]! Bye [PLAYER].", { player }).text).toBe("Hi Ada! Bye Ada.");
  });

  it("hands Decorate the lower-cased tag, the value, the raw content and every keyword, and replaces the whole span", () => {
    const { text, calls } = expand("Take [Item=sword Rarity=Epic size=2]the [b]Sword[/b][/item] now", {
      item: ({ value, content }) => `[img=${value} size=20] [color=orange]${content}[/color]`,
    });
    expect(text).toBe("Take [img=sword size=20] [color=orange]the [b]Sword[/b][/color] now");
    expect(calls).toEqual([{ tag: "item", value: "sword", content: "the [b]Sword[/b]", attrs: { rarity: "Epic", size: "2" } }]);
  });

  it("gives a tag without a closing tag empty content and an empty value when it has no =", () => {
    const { text, calls } = expand("[item] and [item=axe] more", { item: ({ value }) => `<${value}>` });
    expect(text).toBe("<> and <axe> more");
    expect(calls.map((call) => [call.value, call.content])).toEqual([["", ""], ["axe", ""]]);
  });

  it("pairs nested tags of one name inner-first, like brackets", () => {
    const { text, calls } = expand("[q]a[q]b[/q]c[/q]d", { q: ({ content }) => `(${content})` });
    expect(text).toBe("(a(b)c)d");
    expect(calls.map((call) => call.content)).toEqual(["a[q]b[/q]c", "b"]);
  });

  it("expands custom tags in the returned markup, including ones from the raw content it was given", () => {
    const { text, calls } = expand("[hero] / [quote][player][/quote]", {
      hero: () => "[player] the brave",
      quote: ({ content }) => `"${content}"`,
      player,
    });
    expect(text).toBe("Ada the brave / \"Ada\"");
    expect(calls.find((call) => call.tag === "quote")?.content).toBe("[player]");
  });

  it("expands at most eight nested expansions deep and leaves deeper tags as written", () => {
    const { text, calls } = expand("[loop]", { loop: () => "x[loop]" });
    expect(text).toBe("xxxxxxxx[loop]");
    expect(calls).toHaveLength(8);
  });

  it("leaves a tag with no markup as written, still expanding the tags inside it", () => {
    const source = "[none=1]Sword[/none]";
    expect(expand(source, { none: () => null }).text).toBe(source);
    expect(expand("[none][player][/none]", { none: () => null, player }).text).toBe("[none]Ada[/none]");
  });

  it("passes built-in, image, fx, unknown and stray closing tags through", () => {
    // The closing tag comes before any opening one, so nothing pairs with it.
    const { text } = expand("[/player] [b][player][/b] [img=x size=3] [fx=Wave]y[/fx] [unknown] [/b]", { player });
    expect(text).toBe("[/player] [b]Ada[/b] [img=x size=3] [fx=Wave]y[/fx] [unknown] [/b]");
  });

  it("stops before the output passes 100 000 characters, leaving that tag and the rest as written", () => {
    const big = "x".repeat(60_000);
    expect(expand("[big] [big] [player]", { big: () => big, player }).text).toBe(`${big} [big] [player]`);
    // Passed inside a tag's own markup: the outer tag stays as written.
    expect(expand("a [outer] b", { outer: () => "[big][big]", big: () => big }).text).toBe("a [outer] b");
  });
});
