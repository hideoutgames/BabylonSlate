import { describe, expect, it } from "vitest";
import {
  fail,
  matchCommandName,
  ok,
  parseCommandArgs,
  tokenize,
} from "./parser";
import type { CommandParameter } from "./types";

describe("tokenize", () => {
  it("splits on whitespace and keeps quoted values with spaces", () => {
    expect(tokenize(`changescene scene="my level"`)).toEqual([
      "changescene",
      "scene=my level",
    ]);
    expect(tokenize(`foo 'bar baz' qux`)).toEqual(["foo", "bar baz", "qux"]);
  });

  it("accepts name:value as a named token (same as name=value)", () => {
    expect(tokenize("slomo rate:0.25")).toEqual(["slomo", "rate=0.25"]);
  });

  it("returns an empty list for blank input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \t  ")).toEqual([]);
  });
});

describe("parseCommandArgs", () => {
  const params: CommandParameter[] = [
    { name: "level", type: "enum", enumValues: ["low", "medium", "high"] },
    { name: "scale", type: "float", optional: true, defaultValue: 1 },
    { name: "enabled", type: "bool", optional: true },
  ];

  it("fills positional args then applies defaults for omitted optionals", () => {
    expect(parseCommandArgs(["medium"], params)).toEqual({
      ok: true,
      args: { level: "medium", scale: 1 },
    });
  });

  it("coerces bool tokens and prefers named overrides over position", () => {
    expect(
      parseCommandArgs(["high", "enabled=on", "scale=0.5"], params),
    ).toEqual({
      ok: true,
      args: { level: "high", scale: 0.5, enabled: true },
    });
    expect(parseCommandArgs(["low", "enabled=0"], params).ok).toBe(true);
    expect(
      (parseCommandArgs(["low", "enabled=no"], params) as { args: { enabled: boolean } })
        .args.enabled,
    ).toBe(false);
  });

  it("rejects bad int/float/bool/enum values without throwing", () => {
    expect(
      parseCommandArgs(["nope"], [
        { name: "fps", type: "int" },
      ]),
    ).toEqual({
      ok: false,
      output: 'parameter "fps" expects int, got "nope"',
    });
    expect(
      parseCommandArgs(["NaN"], [{ name: "rate", type: "float" }]),
    ).toEqual({
      ok: false,
      output: 'parameter "rate" expects float, got "NaN"',
    });
    expect(
      parseCommandArgs(["maybe"], [{ name: "flag", type: "bool" }]),
    ).toEqual({
      ok: false,
      output: 'parameter "flag" expects bool, got "maybe"',
    });
    expect(
      parseCommandArgs(["ultra"], [
        { name: "level", type: "enum", enumValues: ["low", "high"] },
      ]),
    ).toEqual({
      ok: false,
      output: 'parameter "level" expects one of low, high, got "ultra"',
    });
  });

  it("requires missing non-optional parameters", () => {
    expect(parseCommandArgs([], [{ name: "scene", type: "string" }])).toEqual({
      ok: false,
      output: 'parameter "scene" is required',
    });
  });
});

describe("matchCommandName", () => {
  const known = new Set(["stat unit", "stat memory", "snapshot start", "quit"]);

  it("matches the longest multi-word command name", () => {
    expect(matchCommandName(["stat", "unit", "1"], known)).toEqual({
      name: "stat unit",
      rest: ["1"],
    });
    expect(matchCommandName(["snapshot", "start"], known)).toEqual({
      name: "snapshot start",
      rest: [],
    });
  });

  it("falls back to the first token when nothing matches", () => {
    expect(matchCommandName(["unknown", "arg"], known)).toEqual({
      name: "unknown",
      rest: ["arg"],
    });
    expect(matchCommandName([], known)).toEqual({ name: "", rest: [] });
  });
});

describe("ok / fail helpers", () => {
  it("build CommandResult values", () => {
    expect(ok("done")).toEqual({ success: true, output: "done" });
    expect(fail("nope")).toEqual({ success: false, output: "nope" });
  });
});
