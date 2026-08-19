import { describe, expect, it } from "vitest";
import {
  createCommandRegistry,
  type ConsoleCommandHost,
} from "./registry";
import { createUserCommand } from "./user-commands";

function recordingHost(): ConsoleCommandHost & { calls: string[] } {
  const calls: string[] = [];
  let dilation = 1;
  return {
    calls,
    changeScene: (scene) => {
      calls.push(`changeScene:${scene}`);
    },
    setRenderQuality: (level) => {
      calls.push(`renderquality:${level}`);
    },
    setShadowQuality: (level) => {
      calls.push(`shadowquality:${level}`);
    },
    setResolutionScale: (scale) => {
      calls.push(`resolutionscale:${scale}`);
    },
    setFrameCap: (fps) => {
      calls.push(`framecap:${fps}`);
    },
    setVolume: (volume) => {
      calls.push(`volume:${volume}`);
    },
    getVolume: () => 1,
    getFrameCap: () => 60,
    getRenderQuality: () => "high",
    getResolutionScale: () => 1,
    getShadowQuality: () => "1024",
    quit: () => {
      calls.push("quit");
    },
    setShowFps: (enabled) => {
      calls.push(`showfps:${enabled}`);
    },
    setStat: (name, enabled) => {
      calls.push(`stat:${name}:${enabled}`);
    },
    setShowCollision: (enabled) => {
      calls.push(`showcollision:${enabled}`);
    },
    setShowBounds: (enabled) => {
      calls.push(`showbounds:${enabled}`);
    },
    setWireframe: (enabled) => {
      calls.push(`wireframe:${enabled}`);
    },
    setFreeCam: (enabled) => {
      calls.push(`freecam:${enabled}`);
    },
    setShowNav: (enabled) => {
      calls.push(`shownav:${enabled}`);
    },
    setShowAudioDebug: (enabled) => {
      calls.push(`showaudiodebug:${enabled}`);
    },
    dumpActors: () => "actor-dump",
    inspectActor: (query) => `inspect:${query || "(selection)"}`,
    getInspectSelection: () => null,
    pause: () => {
      calls.push("pause");
    },
    resume: () => {
      calls.push("resume");
    },
    step: () => {
      calls.push("step");
    },
    setTimeDilation: (rate) => {
      dilation = rate;
      calls.push(`slomo:${rate}`);
    },
    getTimeDilation: () => dilation,
    dumpLog: () => "log-tail",
    startSnapshot: () => {
      calls.push("snapshot:start");
    },
    stopSnapshot: () => {
      calls.push("snapshot:stop");
    },
  };
}

describe("createCommandRegistry", () => {
  it("runs core commands in every registry", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: false });
    expect(registry.execute("changescene level-2", host)).toEqual({
      success: true,
      output: "changed scene to level-2",
    });
    expect(registry.execute("renderquality high", host).success).toBe(true);
    expect(registry.execute("shadowquality 1024", host).success).toBe(true);
    expect(registry.execute("resolutionscale 0.75", host).success).toBe(true);
    expect(registry.execute("framecap 30", host).success).toBe(true);
    expect(registry.execute("volume 0.5", host).success).toBe(true);
    expect(registry.execute("quit", host)).toEqual({
      success: true,
      output: "quit",
    });
    expect(host.calls).toEqual([
      "changeScene:level-2",
      "renderquality:high",
      "shadowquality:1024",
      "resolutionscale:0.75",
      "framecap:30",
      "volume:0.5",
      "quit",
    ]);
  });

  it("accepts name=value arguments and quoted strings", () => {
    const host = recordingHost();
    const registry = createCommandRegistry();
    expect(
      registry.execute('changescene scene="my level"', host),
    ).toEqual({
      success: true,
      output: "changed scene to my level",
    });
    expect(host.calls).toEqual(["changeScene:my level"]);
  });

  it("rejects unknown commands without throwing", () => {
    const registry = createCommandRegistry();
    expect(registry.execute("not-a-command", recordingHost())).toEqual({
      success: false,
      output: "unknown command: not-a-command",
    });
  });

  it("reports stripped debug commands instead of unknown", () => {
    const registry = createCommandRegistry({ includeDebug: false });
    expect(registry.execute("showfps", recordingHost())).toEqual({
      success: false,
      output: "debug command 'showfps' is not available in this build",
    });
    expect(registry.execute("stat unit", recordingHost()).output).toContain(
      "stat unit",
    );
    expect(registry.execute("snapshot start", recordingHost()).success).toBe(
      false,
    );
  });

  it("runs debug-tier commands only when includeDebug is true", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: true });
    expect(registry.execute("showfps off", host).success).toBe(true);
    expect(registry.execute("stat memory", host).success).toBe(true);
    expect(registry.execute("pause", host).success).toBe(true);
    expect(registry.execute("freecam", host).success).toBe(true);
    expect(registry.execute("slomo 0.25", host).success).toBe(true);
    expect(registry.execute("dumplog", host)).toEqual({
      success: true,
      output: "log-tail",
    });
    expect(host.calls).toEqual([
      "showfps:false",
      "stat:memory:true",
      "pause",
      "freecam:true",
      "slomo:0.25",
    ]);
  });

  it("turns freecam on by default and off without pausing", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: true });
    expect(registry.execute("freecam", host)).toEqual({
      success: true,
      output: "freecam on",
    });
    expect(registry.execute("freecam off", host)).toEqual({
      success: true,
      output: "freecam off",
    });
    expect(host.calls).toEqual(["freecam:true", "freecam:false"]);
  });

  it("dumps actors and inspects by query", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: true });
    expect(registry.execute("shownav", host)).toEqual({
      success: true,
      output: "shownav on",
    });
    expect(registry.execute("dumpactors", host)).toEqual({
      success: true,
      output: "actor-dump",
    });
    expect(registry.execute("inspect Cube", host)).toEqual({
      success: true,
      output: "inspect:Cube",
    });
    expect(registry.execute("inspect", host)).toEqual({
      success: true,
      output: "inspect:(selection)",
    });
    expect(host.calls).toEqual(["shownav:true"]);
  });

  it("toggles showaudiodebug with true/false and on/off", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: true });
    expect(registry.execute("showaudiodebug true", host)).toEqual({
      success: true,
      output: "showaudiodebug on",
    });
    expect(registry.execute("showaudiodebug false", host)).toEqual({
      success: true,
      output: "showaudiodebug off",
    });
    expect(registry.execute("showaudiodebug on", host).success).toBe(true);
    expect(registry.execute("showaudiodebug off", host).success).toBe(true);
    expect(host.calls).toEqual([
      "showaudiodebug:true",
      "showaudiodebug:false",
      "showaudiodebug:true",
      "showaudiodebug:false",
    ]);
  });

  it("coerces types and rejects bad enum values", () => {
    const registry = createCommandRegistry();
    expect(registry.execute("framecap nope", recordingHost())).toEqual({
      success: false,
      output: 'parameter "fps" expects int, got "nope"',
    });
    expect(registry.execute("renderquality ultra", recordingHost())).toEqual({
      success: false,
      output:
        'parameter "level" expects one of low, medium, high, got "ultra"',
    });
    expect(registry.execute("shadowquality low", recordingHost())).toEqual({
      success: false,
      output:
        'parameter "level" expects one of off, 512, 1024, 2048, got "low"',
    });
    expect(registry.execute("changescene", recordingHost()).success).toBe(false);
  });

  it("prints current setter values when args are omitted", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: false });
    expect(registry.execute("volume", host)).toEqual({
      success: true,
      output: "volume 1",
    });
    expect(registry.execute("framecap", host)).toEqual({
      success: true,
      output: "framecap 60",
    });
    expect(registry.execute("renderquality", host)).toEqual({
      success: true,
      output: "renderquality high",
    });
    expect(registry.execute("resolutionscale", host)).toEqual({
      success: true,
      output: "resolutionscale 1",
    });
    expect(registry.execute("shadowquality", host)).toEqual({
      success: true,
      output: "shadowquality 1024",
    });
    expect(host.calls).toEqual([]);
  });

  it("lists commands with help and details for one name", () => {
    const registry = createCommandRegistry({ includeDebug: true });
    registry.register(
      createUserCommand({
        name: "heal",
        description: "Heal the player",
        category: "game",
        parameters: [{ name: "amount", type: "float" }],
        run: () => ({ success: true, output: "" }),
      }),
    );
    const listed = registry.execute("help", recordingHost());
    expect(listed.success).toBe(true);
    expect(listed.output).toContain("changescene");
    expect(listed.output).toContain("heal");
    expect(listed.output).toContain("pause");
    const pauseHelp = registry.execute("help pause", recordingHost());
    expect(pauseHelp.success).toBe(true);
    expect(pauseHelp.output).toContain("pause");
    expect(pauseHelp.output.toLowerCase()).toContain("pause");
  });

  it("reports stripped names from help instead of unknown", () => {
    const registry = createCommandRegistry({ includeDebug: false });
    expect(registry.execute("help pause", recordingHost())).toEqual({
      success: false,
      output: "debug command 'pause' is not available in this build",
    });
  });

  it("runs resume and unpause", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: true });
    expect(registry.execute("resume", host)).toEqual({
      success: true,
      output: "resumed",
    });
    expect(registry.execute("unpause", host)).toEqual({
      success: true,
      output: "resumed",
    });
    expect(host.calls).toEqual(["resume", "resume"]);
  });

  it("prints current slomo when the rate is omitted", () => {
    const host = recordingHost();
    const registry = createCommandRegistry({ includeDebug: true });
    expect(registry.execute("slomo", host)).toEqual({
      success: true,
      output: "slomo 1",
    });
    expect(registry.execute("slomo 0.25", host)).toEqual({
      success: true,
      output: "slomo 0.25",
    });
    expect(registry.execute("slomo", host)).toEqual({
      success: true,
      output: "slomo 0.25",
    });
  });

  it("refuses user commands that overwrite reserved engine names", () => {
    const registry = createCommandRegistry({ includeDebug: true });
    registry.register(
      createUserCommand({
        name: "pause",
        description: "User pause",
        category: "game",
        parameters: [],
        run: () => ({ success: true, output: "user" }),
      }),
    );
    expect(registry.get("pause")?.tier).toBe("debug");
    expect(registry.execute("pause", recordingHost()).output).toBe("paused");
    const release = createCommandRegistry({ includeDebug: false });
    release.register(
      createUserCommand({
        name: "pause",
        description: "User pause",
        category: "game",
        parameters: [],
        run: () => ({ success: true, output: "user" }),
      }),
    );
    expect(release.get("pause")).toBeUndefined();
    expect(release.execute("pause", recordingHost()).success).toBe(false);
  });
});
