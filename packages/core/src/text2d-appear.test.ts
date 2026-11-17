import { describe, expect, it } from "vitest";
import {
  TEXT2D_APPEAR_TRANSITIONS,
  countText2DRevealCharacters,
  parseText2DAppearProperties,
  sampleText2DAppearTransition,
  text2DAppearDuration,
  text2DAppearSoundPlan,
  text2DCharacterReveal,
  text2DFormattedUnits,
} from "./text2d-appear";
import { createRichText2DComponent, createText2DComponent, parseText2DProperties } from "./text2d";

describe("rich text appear properties", () => {
  it("preserves existing visible text while authoring reveal settings only for rich text", () => {
    const legacy = parseText2DProperties({ text: "Old scene" }, { rich: true });
    expect(legacy.appearStart).toBe("revealed");
    expect(text2DAppearDuration(9, legacy)).toBe(0);
    expect(text2DCharacterReveal(1, 8, 9, legacy)).toBe(1);
    const rich = createRichText2DComponent("rich").properties;
    expect(rich).toMatchObject({ appearModes: [], appearInterval: 0.1, appearDuration: 0.3 });
    expect(createText2DComponent("plain").properties).not.toHaveProperty("appearModes");
    expect(rich).not.toHaveProperty("appearProgress");
  });

  it("normalizes duplicate effects, exclusive Instant, invalid timing, and live progress", () => {
    const parsed = parseText2DAppearProperties({
      appearModes: ["scale", "fade", "scale", "unknown"],
      appearTransition: "invalid", appearInterval: -1, appearDuration: NaN,
      appearStart: "hidden", appearProgress: 2,
    });
    expect(parsed).toEqual({
      appearModes: ["scale", "fade"], appearTransition: "cubicOut", appearInterval: 0.1,
      appearDuration: 0.3, appearStart: "hidden", appearProgress: 1,
      appearSound: false, appearSoundAssetGuid: null, appearSoundPlay: "everyLetter", appearSoundOffset: 0,
    });
    expect(parseText2DAppearProperties({ appearModes: ["fade", "instant", "slide"] }).appearModes).toEqual(["instant"]);
    expect(parseText2DAppearProperties({ appearInterval: 0, appearDuration: 0, appearProgress: Infinity }))
      .toMatchObject({ appearInterval: 0, appearDuration: 0 });
    expect(parseText2DAppearProperties({ appearProgress: Infinity })).not.toHaveProperty("appearProgress");
    expect(parseText2DAppearProperties({ appearProgress: -0.5 }).appearProgress).toBe(0);
  });
});

describe("post-format reveal units", () => {
  it("keeps nested effects and image formatting while omitting tags and line breaks from timing", () => {
    const text = "[b][wave=2 intensity=0.5]A[rotate=45][img=icon size=14]😀[/rotate][/wave][/b]\nZ";
    const units = text2DFormattedUnits(text);
    expect(units.map((unit) => unit.kind === "lineBreak" ? "lineBreak" : [unit.kind, unit.index]))
      .toEqual([["glyph", 0], ["image", 1], ["glyph", 2], "lineBreak", ["glyph", 3]]);
    expect(units[1]).toMatchObject({
      kind: "image", guid: "icon", size: 14,
      style: { bold: true }, effects: { waveSpeed: 2, waveIntensity: 0.5, rotate: 45 },
    });
    expect(units[2]).toMatchObject({ kind: "glyph", ch: "😀", style: { bold: true }, effects: { rotate: 45 } });
    expect(units[4]).toMatchObject({ kind: "glyph", ch: "Z", style: { bold: false }, effects: { waveSpeed: 0, rotate: 0 } });
    expect(countText2DRevealCharacters({ text })).toBe(4);
    expect(countText2DRevealCharacters({ text: "[b]\n[/b]" })).toBe(0);
  });

  it("times literal unknown markup and plain text exactly as displayed", () => {
    expect(countText2DRevealCharacters({ text: "[x]" })).toBe(3);
    expect(countText2DRevealCharacters({ text: "[b]A[/b]", rich: false })).toBe(8);
    expect(countText2DRevealCharacters({ text: "" })).toBe(0);
  });
});

describe("appear timeline", () => {
  const linear = parseText2DAppearProperties({ appearModes: ["fade"], appearTransition: "linear" });

  it("includes the last transition in duration and supports backwards traversal of the same timeline", () => {
    expect(text2DAppearDuration(3, linear)).toBeCloseTo(0.5);
    // Halfway through 0.5 seconds, letters started at 0, 0.1, and 0.2 seconds.
    expect(text2DCharacterReveal(0.5, 0, 3, linear)).toBeCloseTo(5 / 6);
    expect(text2DCharacterReveal(0.5, 1, 3, linear)).toBeCloseTo(0.5);
    expect(text2DCharacterReveal(0.5, 2, 3, linear)).toBeCloseTo(1 / 6);
    expect(text2DCharacterReveal(0.2, 2, 3, linear)).toBe(0);
    expect(text2DCharacterReveal(0.2, 0, 3, linear)).toBeCloseTo(1 / 3);
    expect(text2DCharacterReveal(0, 0, 3, linear)).toBe(0);
    expect(text2DCharacterReveal(1, 2, 3, linear)).toBe(1);
  });

  it("reveals every character together when interval is zero", () => {
    const simultaneous = { ...linear, appearInterval: 0, appearTransition: "cubicOut" as const };
    expect(text2DAppearDuration(20, simultaneous)).toBeCloseTo(0.3);
    expect(text2DCharacterReveal(0.5, 0, 20, simultaneous)).toBeCloseTo(0.875);
    expect(text2DCharacterReveal(0.5, 19, 20, simultaneous)).toBeCloseTo(0.875);
  });

  it("keeps Instant character staggering without creating a fade or transition tail", () => {
    const instant = parseText2DAppearProperties({ appearModes: ["instant"] });
    expect(text2DAppearDuration(3, instant)).toBeCloseTo(0.2);
    expect(text2DCharacterReveal(0, 0, 3, instant)).toBe(0);
    expect(text2DCharacterReveal(0.25, 0, 3, instant)).toBe(1);
    expect(text2DCharacterReveal(0.25, 1, 3, instant)).toBe(0);
    expect(text2DCharacterReveal(0.5, 1, 3, instant)).toBe(1);
    expect(text2DCharacterReveal(1, 2, 3, instant)).toBe(1);
    expect(text2DAppearDuration(3, { ...linear, appearTransition: "instant" })).toBeCloseTo(0.2);
  });

  it("lets Off and zero-duration playback snap between fully hidden and fully visible", () => {
    const off = parseText2DAppearProperties({});
    expect(text2DAppearDuration(3, off)).toBe(0);
    expect(text2DAppearDuration(0, linear)).toBe(0);
    expect(text2DCharacterReveal(0, 0, 3, off)).toBe(0);
    expect(text2DCharacterReveal(1, 2, 3, off)).toBe(1);
    expect(text2DCharacterReveal(0.5, 0, 3, off)).toBe(0);
    const instant = { ...linear, appearDuration: 0, appearInterval: 0 };
    expect(text2DCharacterReveal(0.5, 0, 3, instant)).toBe(0);
    expect(text2DCharacterReveal(1, 2, 3, instant)).toBe(1);
  });
});

describe("appear easing", () => {
  it("has exact hidden and revealed endpoints for every selectable curve", () => {
    for (const transition of TEXT2D_APPEAR_TRANSITIONS) {
      expect(sampleText2DAppearTransition(transition, 0), transition).toBe(0);
      expect(sampleText2DAppearTransition(transition, 1), transition).toBe(1);
      expect(sampleText2DAppearTransition(transition, NaN), transition).toBe(0);
    }
  });

  it("samples the selected curve instead of treating all transitions as linear", () => {
    expect(sampleText2DAppearTransition("cubicOut", 0.25)).toBeCloseTo(0.578125);
    expect(sampleText2DAppearTransition("cubicInOut", 0.25)).toBeCloseTo(0.0625);
    expect(sampleText2DAppearTransition("cubicInOut", 0.75)).toBeCloseTo(0.9375);
    expect(sampleText2DAppearTransition("bounceOut", 0.5)).toBeCloseTo(0.765625);
    expect(sampleText2DAppearTransition("bounceOut", 1 / 2.75)).toBeCloseTo(1);
    expect(sampleText2DAppearTransition("backOut", 0.75)).toBeGreaterThan(1);
    expect(sampleText2DAppearTransition("elasticOut", 0.15)).toBeGreaterThan(1);
    expect(sampleText2DAppearTransition("instant", 0.01)).toBe(1);
  });

  it.each([
    // "Hi [b]you[/b]!" reveals H i _ y o u ! at 0.1 s steps; the space (index 2) is silent.
    { play: "everyLetter", offset: 0, times: [0, 0.1, 0.3, 0.4, 0.5, 0.6] },
    { play: "everyOtherLetter", offset: 0, times: [0, 0.3, 0.5] },
    { play: "everyThirdLetter", offset: 0.05, times: [0.05, 0.45] },
    { play: "everyFourthLetter", offset: 0, times: [0, 0.5] },
    { play: "once", offset: 0.25, times: [0.25] },
    { play: "unknown", offset: -1, times: [0, 0.1, 0.3, 0.4, 0.5, 0.6] },
  ])("schedules the appear sound for $play at offset $offset", ({ play, offset, times }) => {
    const plan = text2DAppearSoundPlan(parseText2DProperties({
      text: "Hi [b]you[/b]!", appearModes: ["fade"], appearInterval: 0.1, appearDuration: 0.3,
      appearSound: true, appearSoundAssetGuid: " beep ", appearSoundPlay: play, appearSoundOffset: offset,
    }, { rich: true }));
    expect(plan?.assetGuid).toBe("beep");
    expect(plan?.loop).toBeNull();
    expect(plan?.times.map((time) => Number(time.toFixed(6)))).toEqual(times);
  });

  it("loops until the last character has appeared and stays silent without a sound, a reveal or the toggle", () => {
    const base = {
      text: "A [img=icon]B", appearModes: ["fade"], appearInterval: 0.1, appearDuration: 0.3,
      appearSound: true, appearSoundAssetGuid: "beep", appearSoundPlay: "loop", appearSoundOffset: 0.1,
    };
    const plan = (overrides: Record<string, unknown>) =>
      text2DAppearSoundPlan(parseText2DProperties({ ...base, ...overrides }, { rich: true }));
    // Four characters: three 0.1 s intervals and a 0.3 s transition.
    const loop = plan({})!;
    expect(loop.times).toEqual([]);
    expect(loop.loop!.start).toBe(0.1);
    expect(loop.loop!.stop).toBeCloseTo(0.6);
    expect(plan({ appearSoundOffset: 0.7 })).toBeNull();
    // An inline image counts as a letter; characters that start together share one sound.
    expect(plan({ appearSoundPlay: "everyLetter", appearSoundOffset: 0 })!.times.map((t) => Number(t.toFixed(6)))).toEqual([0, 0.2, 0.3]);
    expect(plan({ appearSoundPlay: "everyLetter", appearInterval: 0 })!.times).toEqual([0.1]);
    expect(plan({ appearSound: false })).toBeNull();
    expect(plan({ appearSoundAssetGuid: null })).toBeNull();
    expect(plan({ appearModes: [] })).toBeNull();
    expect(plan({ text: "[b][/b]" })).toBeNull();
  });
});
