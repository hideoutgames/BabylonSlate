import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "./registry";
import { createUserCommand } from "./user-commands";
import type { ConsoleCommandHost } from "./types";

function host(): ConsoleCommandHost {
  return {
    changeScene: () => {},
    setRenderQuality: () => {},
    setShadowQuality: () => {},
    setResolutionScale: () => {},
    setFrameCap: () => {},
    setVolume: () => {},
    quit: () => {},
  };
}

describe("createUserCommand", () => {
  it("registers a core-tier command that runs without the debugger", () => {
    const registry = createCommandRegistry({ includeDebug: false });
    registry.register(
      createUserCommand({
        name: "heal",
        description: "Heal the player",
        category: "game",
        parameters: [{ name: "amount", type: "float" }],
        run: (args) => ({
          success: true,
          output: `healed ${args.amount}`,
        }),
      }),
    );
    expect(registry.get("heal")?.tier).toBe("core");
    expect(registry.execute("heal 25", host())).toEqual({
      success: true,
      output: "healed 25",
    });
    expect(registry.execute("showfps", host()).success).toBe(false);
  });
});
