import { describe, expect, it } from "vitest";
import { GameInstance } from "@babylonslate/object-model";
import { createInProcessRuntime } from "./driver";

describe("RuntimeDriver.executeConsoleCommand", () => {
  it("runs changescene through the command registry", () => {
    let loaded: string | undefined;
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
    });
    runtime.getWorld().setGameInstance(
      new GameInstance({
        classId: "GameInstance",
        guid: "gi",
        hooks: {
          onSceneLoaded: (_self, sceneName) => {
            loaded = sceneName;
          },
        },
      }),
    );
    expect(runtime.executeConsoleCommand("changescene other-level")).toEqual({
      success: true,
      output: "changed scene to other-level",
    });
    expect(loaded).toBe("other-level");
    runtime.stop();
  });

  it("reports stripped debug commands when includeDebugCommands is false", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      includeDebugCommands: false,
    });
    expect(runtime.executeConsoleCommand("showfps")).toEqual({
      success: false,
      output: "debug command 'showfps' is not available in this build",
    });
    runtime.stop();
  });

  it("runs a user BDebugCommand from the console without the debug tier", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      includeDebugCommands: false,
    });
    runtime.registerUserCommand({
      name: "heal",
      description: "Heal the player",
      category: "game",
      parameters: [{ name: "amount", type: "float" }],
      run: (args) => ({ success: true, output: `healed ${args.amount}` }),
    });
    expect(runtime.executeConsoleCommand("heal 10")).toEqual({
      success: true,
      output: "healed 10",
    });
    expect(runtime.listConsoleCommands().some((c) => c.name === "heal")).toBe(
      true,
    );
    runtime.stop();
  });
});
