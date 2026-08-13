import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "./registry";
import { suggestConsoleCompletions } from "./autocomplete";
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
    ).toEqual(["low", "medium", "high"]);
  });
});
