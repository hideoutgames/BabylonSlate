import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "./registry";
import {
  applyConsoleCompletion,
  suggestConsoleCompletions,
} from "./autocomplete";
import { createUserCommand } from "./user-commands";

describe("suggestConsoleCompletions", () => {
  it("ranks command prefixes before interior and fuzzy matches", () => {
    const commands = ["shownav", "navinspect", "navigation", "showbounds", "debugphysics"].map((name) =>
      createUserCommand({ name, description: name, category: "debug", parameters: [], run: () => ({ success: true, output: "" }) }),
    );
    expect(suggestConsoleCompletions("nav", commands)).toEqual([
      "navigation", "navinspect", "shownav",
    ]);
    expect(suggestConsoleCompletions("PHYSICS", commands)).toEqual(["debugphysics"]);
    expect(suggestConsoleCompletions("dbphys", commands)).toEqual(["debugphysics"]);
    expect(suggestConsoleCompletions("zzzzz", commands)).toEqual([]);
  });

  it("completes named arguments in any order and finds context substrings", () => {
    const command = createUserCommand({
      name: "follow", description: "Follow an actor", category: "game",
      parameters: [
        { name: "actor", type: "string", complete: "actors" },
        { name: "enabled", type: "bool" },
      ],
      run: () => ({ success: true, output: "" }),
    });
    expect(suggestConsoleCompletions("follow enabled=o", [command])).toEqual(["on", "off"]);
    expect(suggestConsoleCompletions("follow enabled=on Gu", [command], { actors: ["North Guard", "Guide"] })).toEqual(["Guide", "North Guard"]);
    expect(suggestConsoleCompletions('follow actor="North G', [command], { actors: ["North Guard"] })).toEqual(["North Guard"]);
  });

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
    expect(suggestConsoleCompletions("he", registry.list())).toEqual([
      "heal",
      "help",
    ]);
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
  it("quotes completed values and preserves earlier quoted arguments", () => {
    const command = createUserCommand({
      name: "follow", description: "Follow", category: "game",
      parameters: [{ name: "actor", type: "string" }, { name: "mode", type: "string" }],
      run: () => ({ success: true, output: "" }),
    });
    expect(applyConsoleCompletion("follow No", "North Guard", [command])).toBe('follow "North Guard"');
    expect(applyConsoleCompletion('follow actor="North G', "North Guard", [command])).toBe('follow actor="North Guard"');
    expect(applyConsoleCompletion('follow "North Guard" mode=fa', "fast", [command])).toBe('follow "North Guard" mode=fast');
  });

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
