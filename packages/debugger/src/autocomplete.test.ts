import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "./registry";
import {
  applyConsoleCompletion,
  suggestConsoleCompletions,
} from "./autocomplete";
import { createUserCommand } from "./user-commands";

describe("suggestConsoleCompletions", () => {
  it("prefix-matches command names including user commands", () => {
    const registry = createCommandRegistry({ includeDebug: true });
    registry.register(
      createUserCommand({
        name: "heal",
        description: "Heal",
        category: "game",
        parameters: [{ name: "amount", type: "float" }],
        run: () => ({ success: true, output: "" }),
      }),
    );
    expect(suggestConsoleCompletions("ch", registry.list())).toEqual([
      "changescene",
    ]);
    expect(suggestConsoleCompletions("he", registry.list())).toEqual(["heal"]);
  });

  it("suggests enum values for the current parameter", () => {
    const registry = createCommandRegistry();
    expect(
      suggestConsoleCompletions("renderquality ", registry.list()),
    ).toEqual(["level=", "low", "medium", "high"]);
  });

  it("suggests on/off for bool flags", () => {
    const registry = createCommandRegistry({ includeDebug: true });
    expect(suggestConsoleCompletions("showfps ", registry.list())).toEqual([
      "enabled=",
      "on",
      "off",
    ]);
    expect(suggestConsoleCompletions("showfps o", registry.list())).toEqual([
      "on",
      "off",
    ]);
  });

  it("suggests named param= chips and default numeric values", () => {
    const registry = createCommandRegistry({ includeDebug: true });
    expect(suggestConsoleCompletions("slomo ", registry.list())).toContain(
      "rate=",
    );
    expect(
      suggestConsoleCompletions("resolutionscale ", registry.list()),
    ).toContain("scale=");
  });

  it("suggests scene names, actor ids, and command names from context", () => {
    const registry = createCommandRegistry({ includeDebug: true });
    expect(
      suggestConsoleCompletions("changescene ", registry.list(), {
        scenes: ["Level2", "hub"],
      }),
    ).toEqual(["scene=", "Level2", "hub"]);
    const inspect = createUserCommand({
      name: "inspect",
      description: "Inspect",
      category: "engine",
      parameters: [{ name: "target", type: "string", complete: "actors" }],
      run: () => ({ success: true, output: "" }),
    });
    const help = createUserCommand({
      name: "help",
      description: "Help",
      category: "engine",
      parameters: [
        { name: "name", type: "string", complete: "commands", optional: true },
      ],
      run: () => ({ success: true, output: "" }),
    });
    expect(
      suggestConsoleCompletions("inspect He", [inspect], {
        actors: ["Hero", "hero-guid"],
      }),
    ).toEqual(["Hero", "hero-guid"]);
    expect(
      suggestConsoleCompletions("help pa", [help], {
        commands: ["pause", "path"],
      }),
    ).toEqual(["pause", "path"]);
  });
});

describe("applyConsoleCompletion", () => {
  it("replaces the current token instead of the whole line", () => {
    const registry = createCommandRegistry();
    expect(applyConsoleCompletion("ch", "changescene", registry.list())).toBe(
      "changescene ",
    );
    expect(
      applyConsoleCompletion("renderquality ", "high", registry.list()),
    ).toBe("renderquality high");
    expect(
      applyConsoleCompletion("renderquality me", "medium", registry.list()),
    ).toBe("renderquality medium");
    expect(
      applyConsoleCompletion("showfps ", "enabled=", registry.list()),
    ).toBe("showfps enabled=");
  });
});
