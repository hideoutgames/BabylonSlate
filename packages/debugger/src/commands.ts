import { ok } from "./parser";
import type {
  CommandParameter,
  ConsoleCommandHost,
  RegisteredCommand,
} from "./types";

const QUALITY: CommandParameter = {
  name: "level",
  type: "enum",
  enumValues: ["low", "medium", "high"],
};

const SHADOW_QUALITY: CommandParameter = {
  name: "level",
  type: "enum",
  enumValues: ["off", "512", "1024", "2048"],
};

const FLAG: CommandParameter = {
  name: "enabled",
  type: "bool",
  optional: true,
  defaultValue: true,
};

export const CORE_COMMAND_NAMES = [
  "changescene",
  "renderquality",
  "shadowquality",
  "resolutionscale",
  "framecap",
  "volume",
  "quit",
] as const;

export const DEBUG_COMMAND_NAMES = [
  "showfps",
  "stat unit",
  "stat memory",
  "stat draws",
  "stat threads",
  "showcollision",
  "showbounds",
  "wireframe",
  "pause",
  "step",
  "slomo",
  "dumplog",
  "snapshot start",
  "snapshot stop",
] as const;

function flagCommand(
  name: (typeof DEBUG_COMMAND_NAMES)[number],
  apply: (host: ConsoleCommandHost, enabled: boolean) => void,
): RegisteredCommand {
  return {
    name,
    tier: "debug",
    description: name,
    parameters: [FLAG],
    run(args, host) {
      const enabled = Boolean(args.enabled);
      apply(host, enabled);
      return ok(`${name} ${enabled ? "on" : "off"}`);
    },
  };
}

function statCommand(
  name: "stat unit" | "stat memory" | "stat draws" | "stat threads",
  stat: string,
): RegisteredCommand {
  return {
    name,
    tier: "debug",
    description: name,
    parameters: [],
    run(_args, host) {
      host.setStat?.(stat, true);
      return ok(`${name} on`);
    },
  };
}

export function builtinCommands(): RegisteredCommand[] {
  return [
    {
      name: "changescene",
      tier: "core",
      description: "Load a scene by asset guid",
      parameters: [{ name: "scene", type: "string" }],
      run(args, host) {
        const scene = String(args.scene);
        host.changeScene(scene);
        return ok(`changed scene to ${scene}`);
      },
    },
    {
      name: "renderquality",
      tier: "core",
      description: "Set render quality",
      parameters: [QUALITY],
      run(args, host) {
        const level = String(args.level);
        host.setRenderQuality(level);
        return ok(`renderquality ${level}`);
      },
    },
    {
      name: "shadowquality",
      tier: "core",
      description: "Set shadow map size",
      parameters: [SHADOW_QUALITY],
      run(args, host) {
        const level = String(args.level);
        host.setShadowQuality(level);
        return ok(`shadowquality ${level}`);
      },
    },
    {
      name: "resolutionscale",
      tier: "core",
      description: "Set resolution scale",
      parameters: [{ name: "scale", type: "float" }],
      run(args, host) {
        const scale = Number(args.scale);
        host.setResolutionScale(scale);
        return ok(`resolutionscale ${scale}`);
      },
    },
    {
      name: "framecap",
      tier: "core",
      description: "Set frame cap",
      parameters: [{ name: "fps", type: "int" }],
      run(args, host) {
        const fps = Number(args.fps);
        host.setFrameCap(fps);
        return ok(`framecap ${fps}`);
      },
    },
    {
      name: "volume",
      tier: "core",
      description: "Set master volume",
      parameters: [{ name: "volume", type: "float" }],
      run(args, host) {
        const volume = Number(args.volume);
        host.setVolume(volume);
        return ok(`volume ${volume}`);
      },
    },
    {
      name: "quit",
      tier: "core",
      description: "Stop the session",
      parameters: [],
      run(_args, host) {
        host.quit();
        return ok("quit");
      },
    },
    flagCommand("showfps", (host, enabled) => host.setShowFps?.(enabled)),
    statCommand("stat unit", "unit"),
    statCommand("stat memory", "memory"),
    statCommand("stat draws", "draws"),
    statCommand("stat threads", "threads"),
    flagCommand("showcollision", (host, enabled) =>
      host.setShowCollision?.(enabled),
    ),
    flagCommand("showbounds", (host, enabled) => host.setShowBounds?.(enabled)),
    flagCommand("wireframe", (host, enabled) => host.setWireframe?.(enabled)),
    {
      name: "pause",
      tier: "debug",
      description: "Pause simulation",
      parameters: [],
      run(_args, host) {
        host.pause?.();
        return ok("paused");
      },
    },
    {
      name: "step",
      tier: "debug",
      description: "Step one tick",
      parameters: [],
      run(_args, host) {
        host.step?.();
        return ok("step");
      },
    },
    {
      name: "slomo",
      tier: "debug",
      description: "Set time dilation",
      parameters: [{ name: "rate", type: "float" }],
      run(args, host) {
        const rate = Number(args.rate);
        host.setTimeDilation?.(rate);
        return ok(`slomo ${rate}`);
      },
    },
    {
      name: "dumplog",
      tier: "debug",
      description: "Dump the log ring",
      parameters: [],
      run(_args, host) {
        return ok(host.dumpLog?.() ?? "");
      },
    },
    {
      name: "snapshot start",
      tier: "debug",
      description: "Start the debug snapshot recorder",
      parameters: [],
      run(_args, host) {
        host.startSnapshot?.();
        return ok("snapshot recording");
      },
    },
    {
      name: "snapshot stop",
      tier: "debug",
      description: "Stop the debug snapshot recorder",
      parameters: [],
      run(_args, host) {
        host.stopSnapshot?.();
        return ok("snapshot stopped");
      },
    },
  ];
}
