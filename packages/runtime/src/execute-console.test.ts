import { describe, expect, it } from "vitest";
import { GameInstance } from "@babylonslate/object-model";
import type { CommandMessage } from "@babylonslate/bridge";
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

  it("emits sessionPaused from pause and resume without treating overlay pause as a console command", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    runtime.pause();
    expect(commands.some((command) => command.type === "sessionPaused")).toBe(
      false,
    );
    expect(runtime.executeConsoleCommand("pause")).toEqual({
      success: true,
      output: "paused",
    });
    expect(
      commands.filter((command) => command.type === "sessionPaused"),
    ).toEqual([{ type: "sessionPaused", paused: true }]);
    commands.length = 0;
    expect(runtime.executeConsoleCommand("resume")).toEqual({
      success: true,
      output: "resumed",
    });
    expect(
      commands.filter((command) => command.type === "sessionPaused"),
    ).toEqual([{ type: "sessionPaused", paused: false }]);
    expect(runtime.executeConsoleCommand("unpause").output).toBe("resumed");
    runtime.stop();
  });

  it("advances one tick from step while staying paused", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
    });
    runtime.start();
    runtime.pause();
    const before = runtime.getWorld().clock.tickIndex;
    expect(runtime.executeConsoleCommand("step")).toEqual({
      success: true,
      output: "step",
    });
    expect(runtime.getWorld().clock.tickIndex).toBe(before + 1);
    runtime.tick();
    expect(runtime.getWorld().clock.tickIndex).toBe(before + 1);
    runtime.stop();
  });

  it("lists user commands from help and refuses a reserved overwrite", () => {
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
    });
    runtime.registerUserCommand({
      name: "heal",
      description: "Heal the player",
      category: "game",
      parameters: [],
      run: () => ({ success: true, output: "healed" }),
    });
    runtime.registerUserCommand({
      name: "pause",
      description: "User pause",
      category: "game",
      parameters: [],
      run: () => ({ success: true, output: "user" }),
    });
    const listed = runtime.executeConsoleCommand("help");
    expect(listed.success).toBe(true);
    expect(listed.output).toContain("heal");
    expect(listed.output).toContain("pause");
    expect(runtime.executeConsoleCommand("pause").output).toBe("paused");
    runtime.stop();
  });
});
