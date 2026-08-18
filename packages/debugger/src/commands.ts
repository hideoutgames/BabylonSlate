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
  optional: true,
};

const SHADOW_QUALITY: CommandParameter = {
  name: "level",
  type: "enum",
  enumValues: ["off", "512", "1024", "2048"],
  optional: true,
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
  "help",
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
  "resume",
  "unpause",
  "step",
  "slomo",
  "dumplog",
  "snapshot start",
  "snapshot stop",
  "freecam",
  "shownav",
  "showaudiodebug",
  "dumpactors",
  "inspect",
] as const;

export function isReservedConsoleCommandName(name: string): boolean {
  return RESERVED_COMMAND_NAMES.has(name.trim().toLowerCase());
}

const RESERVED_COMMAND_NAMES = new Set<string>([
  ...CORE_COMMAND_NAMES,
  ...DEBUG_COMMAND_NAMES,
]);

function flagCommand(
  name: (typeof DEBUG_COMMAND_NAMES)[number],
  apply: (host: ConsoleCommandHost, enabled: boolean) => void,
  description: string = name,
): RegisteredCommand {
  return {
    name,
    tier: "debug",
    category: "engine",
    description,
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
    category: "engine",
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
      category: "engine",
      description: "Load a scene by asset guid",
      parameters: [{ name: "scene", type: "string", complete: "scenes" }],
      run(args, host) {
        const scene = String(args.scene);
        host.changeScene(scene);
        return ok(`changed scene to ${scene}`);
      },
    },
    {
      name: "renderquality",
      tier: "core",
      category: "engine",
      description: "Set render quality",
      parameters: [QUALITY],
      run(args, host) {
        if (args.level === undefined) {
          return ok(`renderquality ${host.getRenderQuality?.() ?? "high"}`);
        }
        const level = String(args.level);
        host.setRenderQuality(level);
        return ok(`renderquality ${level}`);
      },
    },
    {
      name: "shadowquality",
      tier: "core",
      category: "engine",
      description: "Set shadow map size",
      parameters: [SHADOW_QUALITY],
      run(args, host) {
        if (args.level === undefined) {
          return ok(`shadowquality ${host.getShadowQuality?.() ?? "1024"}`);
        }
        const level = String(args.level);
        host.setShadowQuality(level);
        return ok(`shadowquality ${level}`);
      },
    },
    {
      name: "resolutionscale",
      tier: "core",
      category: "engine",
      description: "Set resolution scale",
      parameters: [{ name: "scale", type: "float", optional: true }],
      run(args, host) {
        if (args.scale === undefined) {
          return ok(`resolutionscale ${host.getResolutionScale?.() ?? 1}`);
        }
        const scale = Number(args.scale);
        host.setResolutionScale(scale);
        return ok(`resolutionscale ${scale}`);
      },
    },
    {
      name: "framecap",
      tier: "core",
      category: "engine",
      description: "Set frame cap",
      parameters: [{ name: "fps", type: "int", optional: true }],
      run(args, host) {
        if (args.fps === undefined) {
          return ok(`framecap ${host.getFrameCap?.() ?? 60}`);
        }
        const fps = Number(args.fps);
        host.setFrameCap(fps);
        return ok(`framecap ${fps}`);
      },
    },
    {
      name: "volume",
      tier: "core",
      category: "engine",
      description: "Set master volume",
      parameters: [{ name: "volume", type: "float", optional: true }],
      run(args, host) {
        if (args.volume === undefined) {
          return ok(`volume ${host.getVolume?.() ?? 1}`);
        }
        const volume = Number(args.volume);
        host.setVolume(volume);
        return ok(`volume ${volume}`);
      },
    },
    {
      name: "quit",
      tier: "core",
      category: "engine",
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
    flagCommand(
      "freecam",
      (host, enabled) => host.setFreeCam?.(enabled),
      "Detached fly camera; simulation keeps running",
    ),
    flagCommand("shownav", (host, enabled) => host.setShowNav?.(enabled)),
    flagCommand("showaudiodebug", (host, enabled) =>
      host.setShowAudioDebug?.(enabled),
    ),
    {
      name: "dumpactors",
      tier: "debug",
      category: "engine",
      description: "Print spawned actors",
      parameters: [],
      run(_args, host) {
        return ok(host.dumpActors?.() ?? "");
      },
    },
    {
      name: "inspect",
      tier: "debug",
      category: "engine",
      description: "Print inspect snapshot for an actor",
      parameters: [
        {
          name: "query",
          type: "string",
          optional: true,
          complete: "actors",
        },
      ],
      run(args, host) {
        const query =
          typeof args.query === "string" ? args.query : "";
        return ok(
          host.inspectActor?.(query) ?? "inspect <name|guid>",
        );
      },
    },
    {
      name: "pause",
      tier: "debug",
      category: "engine",
      description: "Pause simulation",
      parameters: [],
      run(_args, host) {
        host.pause?.();
        return ok("paused");
      },
    },
    {
      name: "resume",
      tier: "debug",
      category: "engine",
      description: "Resume simulation",
      parameters: [],
      run(_args, host) {
        host.resume?.();
        return ok("resumed");
      },
    },
    {
      name: "unpause",
      tier: "debug",
      category: "engine",
      description: "Resume simulation",
      parameters: [],
      run(_args, host) {
        host.resume?.();
        return ok("resumed");
      },
    },
    {
      name: "step",
      tier: "debug",
      category: "engine",
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
      category: "engine",
      description: "Set time dilation",
      parameters: [{ name: "rate", type: "float", optional: true }],
      run(args, host) {
        if (args.rate === undefined) {
          return ok(`slomo ${host.getTimeDilation?.() ?? 1}`);
        }
        const rate = Number(args.rate);
        host.setTimeDilation?.(rate);
        return ok(`slomo ${host.getTimeDilation?.() ?? rate}`);
      },
    },
    {
      name: "dumplog",
      tier: "debug",
      category: "engine",
      description: "Dump the log ring",
      parameters: [],
      run(_args, host) {
        return ok(host.dumpLog?.() ?? "");
      },
    },
    {
      name: "snapshot start",
      tier: "debug",
      category: "engine",
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
      category: "engine",
      description: "Stop the debug snapshot recorder",
      parameters: [],
      run(_args, host) {
        host.stopSnapshot?.();
        return ok("snapshot stopped");
      },
    },
  ];
}

function formatParam(param: CommandParameter): string {
  const type =
    param.type === "enum" && param.enumValues
      ? `enum (${param.enumValues.join(", ")})`
      : param.type;
  const optional =
    param.optional || param.defaultValue !== undefined ? ", optional" : "";
  return `  ${param.name}: ${type}${optional}`;
}

export function formatCommandHelp(command: RegisteredCommand): string {
  const header = `${command.name} — ${command.description}`;
  if (command.parameters.length === 0) return header;
  return [header, ...command.parameters.map(formatParam)].join("\n");
}

export function formatCommandList(
  commands: readonly RegisteredCommand[],
): string {
  const groups = new Map<string, RegisteredCommand[]>();
  for (const command of commands) {
    const category = command.category?.trim() || "engine";
    const list = groups.get(category) ?? [];
    list.push(command);
    groups.set(category, list);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === "engine") return -1;
    if (b === "engine") return 1;
    return a.localeCompare(b);
  });
  const lines: string[] = [];
  for (const key of keys) {
    lines.push(`${key}:`);
    const rows = groups.get(key) ?? [];
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const command of rows) {
      lines.push(`  ${command.name} — ${command.description}`);
    }
  }
  return lines.join("\n");
}

export function createHelpCommand(
  list: () => readonly RegisteredCommand[],
  stripped: ReadonlySet<string>,
): RegisteredCommand {
  return {
    name: "help",
    tier: "core",
    category: "engine",
    description: "List commands or show usage for one name",
    parameters: [
      {
        name: "name",
        type: "string",
        optional: true,
        complete: "commands",
      },
    ],
    run(args) {
      const query = typeof args.name === "string" ? args.name.trim() : "";
      if (!query) {
        return ok(formatCommandList(list()));
      }
      const key = query.toLowerCase();
      if (stripped.has(key)) {
        return {
          success: false,
          output: `debug command '${key}' is not available in this build`,
        };
      }
      const command = list().find((entry) => entry.name.toLowerCase() === key);
      if (!command) {
        return {
          success: false,
          output: `unknown command: ${query}`,
        };
      }
      return ok(formatCommandHelp(command));
    },
  };
}
