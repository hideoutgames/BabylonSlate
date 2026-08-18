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

  it("emits apply commands for core setters and prints current with no args", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      includeDebugCommands: false,
      onCommand: (command) => commands.push(command),
    });
    expect(runtime.executeConsoleCommand("volume 0.25")).toEqual({
      success: true,
      output: "volume 0.25",
    });
    expect(runtime.executeConsoleCommand("framecap 30")).toEqual({
      success: true,
      output: "framecap 30",
    });
    expect(runtime.executeConsoleCommand("renderquality low")).toEqual({
      success: true,
      output: "renderquality low",
    });
    expect(runtime.executeConsoleCommand("resolutionscale 1.5")).toEqual({
      success: true,
      output: "resolutionscale 1.5",
    });
    expect(
      commands.filter(
        (command) =>
          command.type === "setGlobalVolume" ||
          command.type === "setFrameCap" ||
          command.type === "setRenderQuality" ||
          command.type === "setResolutionScale",
      ),
    ).toEqual([
      { type: "setGlobalVolume", volume: 0.25 },
      { type: "setFrameCap", fps: 30 },
      { type: "setRenderQuality", level: "low" },
      { type: "setResolutionScale", scale: 1.5 },
    ]);
    expect(runtime.executeConsoleCommand("volume").output).toBe("volume 0.25");
    expect(runtime.executeConsoleCommand("framecap").output).toBe("framecap 30");
    expect(runtime.executeConsoleCommand("renderquality").output).toBe(
      "renderquality low",
    );
    expect(runtime.executeConsoleCommand("resolutionscale").output).toBe(
      "resolutionscale 1.5",
    );
    runtime.stop();
  });

  it("scales script and physics tick dt by slomo and clamps the rate", () => {
    const dts: number[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      dt: 1 / 60,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
    });
    runtime.start();
    const actor = runtime.getWorld().createActor({
      guid: "probe",
      classId: "Actor",
      hooks: {
        onTick: (_self, ctx) => {
          dts.push(ctx.dt);
        },
      },
    });
    runtime.getWorld().spawnActorNow(actor);
    runtime.tick();
    expect(dts.at(-1)).toBeCloseTo(1 / 60);
    expect(runtime.executeConsoleCommand("slomo 2")).toEqual({
      success: true,
      output: "slomo 2",
    });
    runtime.tick();
    expect(dts.at(-1)).toBeCloseTo(2 / 60);
    expect(runtime.getWorld().clock.dt).toBeCloseTo(2 / 60);
    expect(runtime.executeConsoleCommand("slomo").output).toBe("slomo 2");
    expect(runtime.executeConsoleCommand("slomo 99").output).toBe("slomo 8");
    runtime.tick();
    expect(dts.at(-1)).toBeCloseTo(8 / 60);
    expect(runtime.executeConsoleCommand("slomo -1").output).toBe("slomo 0");
    runtime.stop();
  });

  it("emits setFreeCam without pausing the simulation", () => {
    const commands: CommandMessage[] = [];
    const dts: number[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    const actor = runtime.getWorld().createActor({
      guid: "probe",
      classId: "Actor",
      hooks: {
        onTick: (_self, ctx) => {
          dts.push(ctx.dt);
        },
      },
    });
    runtime.getWorld().spawnActorNow(actor);
    const before = runtime.getWorld().clock.tickIndex;
    expect(runtime.executeConsoleCommand("freecam")).toEqual({
      success: true,
      output: "freecam on",
    });
    expect(
      commands.filter((command) => command.type === "setFreeCam"),
    ).toEqual([{ type: "setFreeCam", enabled: true }]);
    expect(commands.some((command) => command.type === "sessionPaused")).toBe(
      false,
    );
    runtime.tick();
    expect(runtime.getWorld().clock.tickIndex).toBe(before + 1);
    expect(dts.length).toBeGreaterThan(0);
    runtime.stop();
  });

  it("emits visualization commands and formats dumpactors/inspect", () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      onCommand: (command) => commands.push(command),
    });
    runtime.start();
    const actor = runtime.getWorld().createActor({
      guid: "cube",
      classId: "Actor",
      variables: { name: "Cube" },
    });
    runtime.getWorld().spawnActorNow(actor);
    expect(runtime.executeConsoleCommand("showfps")).toEqual({
      success: true,
      output: "showfps on",
    });
    expect(runtime.executeConsoleCommand("stat unit")).toEqual({
      success: true,
      output: "stat unit on",
    });
    expect(runtime.executeConsoleCommand("wireframe")).toEqual({
      success: true,
      output: "wireframe on",
    });
    expect(runtime.executeConsoleCommand("showbounds")).toEqual({
      success: true,
      output: "showbounds on",
    });
    expect(runtime.executeConsoleCommand("shownav")).toEqual({
      success: true,
      output: "shownav on",
    });
    expect(runtime.executeConsoleCommand("showaudiodebug")).toEqual({
      success: true,
      output: "showaudiodebug on",
    });
    expect(runtime.executeConsoleCommand("showcollision")).toEqual({
      success: true,
      output: "showcollision on",
    });
    expect(
      commands.filter((command) => command.type === "setShowFps"),
    ).toEqual([
      { type: "setShowFps", enabled: true },
      { type: "setShowFps", enabled: true },
    ]);
    expect(
      commands.some((command) => command.type === "setStat" && command.name === "unit"),
    ).toBe(true);
    expect(
      commands.filter((command) => command.type === "setShowNav"),
    ).toEqual([{ type: "setShowNav", enabled: true }]);
    expect(
      commands.filter((command) => command.type === "setShowAudioDebug"),
    ).toEqual([{ type: "setShowAudioDebug", enabled: true }]);
    expect(
      commands.filter((command) => command.type === "setWireframe"),
    ).toEqual([{ type: "setWireframe", enabled: true }]);
    expect(
      commands.filter((command) => command.type === "debugColliders"),
    ).toEqual([{ type: "debugColliders", colliders: [] }]);
    expect(runtime.executeConsoleCommand("dumpactors").output).toContain(
      "Cube Actor cube",
    );
    expect(runtime.executeConsoleCommand("inspect Cube").output).toContain(
      "Cube Actor cube",
    );
    expect(runtime.executeConsoleCommand("inspect").output).toBe(
      "inspect <name|guid>",
    );
    runtime.stop();
  });
});
