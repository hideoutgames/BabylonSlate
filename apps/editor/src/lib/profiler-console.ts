import { EDITOR_COMMAND_NAMES, matchCommandName, tokenize, type CommandResult, type RegisteredCommand } from "@haptic/debugger";
import type { DiagnosticProfileOptions, DiagnosticResultsStore } from "../services/diagnostic-results-store";

const noop = (): CommandResult => ({ success: true, output: "" });
const ok = (output: string): CommandResult => ({ success: true, output });
const fail = (output: string): CommandResult => ({ success: false, output });
const [PROFILE_START, PROFILE_STOP, CAPTURE_FRAME] = EDITOR_COMMAND_NAMES;

/**
 * Console commands the editor runs itself, against the Profiler, instead of sending them to the game:
 * the Profiler records in the editor. They are listed for completion like the game's commands.
 */
export const PROFILER_CONSOLE_COMMANDS: readonly RegisteredCommand[] = [
  { name: PROFILE_START, tier: "debug", category: "profiler", description: "Start a performance recording, like Record Performance", parameters: [], run: noop },
  { name: PROFILE_STOP, tier: "debug", category: "profiler", description: "Stop the performance recording and show its Summary", parameters: [], run: noop },
  { name: CAPTURE_FRAME, tier: "debug", category: "profiler", description: "Capture the render stages of the next frame", parameters: [], run: noop },
];

const NAMES: ReadonlySet<string> = new Set(PROFILER_CONSOLE_COMMANDS.map((command) => command.name));

/**
 * Runs `line` when it is a Profiler command, or `help` for one, and resolves to null for the game to
 * run it. `profileOptions` are read when a recording starts, as Record Performance reads them.
 */
export async function runProfilerConsoleCommand(
  line: string,
  store: DiagnosticResultsStore | null,
  profileOptions: () => DiagnosticProfileOptions,
): Promise<CommandResult | null> {
  const tokens = tokenize(line);
  if (tokens[0]?.toLowerCase() === "help") {
    const { name } = matchCommandName(tokens.slice(1), NAMES);
    const command = PROFILER_CONSOLE_COMMANDS.find((entry) => entry.name === name);
    return command ? ok(`${command.name} — ${command.description}`) : null;
  }
  const { name, rest } = matchCommandName(tokens, NAMES);
  if (!NAMES.has(name)) {
    // A bare group word lists its subcommands, as the game's own groups (`snapshot`) do.
    const subcommands = [...NAMES].filter((known) => known.startsWith(`${name} `)).map((known) => known.slice(name.length + 1));
    return subcommands.length > 0 && rest.length === 0 ? fail(`usage: ${name} <${subcommands.join("|")}>`) : null;
  }
  if (rest.length > 0) return fail(`${name} takes no arguments`);
  if (!store) return fail("The Profiler is not available here.");
  if (name === PROFILE_START) {
    await store.startProfile(profileOptions());
    const { active, error } = store.getSnapshot();
    return active === "profile" ? ok("Recording performance. Type profile stop to stop.") : fail(error ?? "Recording could not start.");
  }
  if (name === PROFILE_STOP) {
    if (store.getSnapshot().active !== "profile") return fail("No performance recording is running.");
    await store.stopProfile();
    const { error } = store.getSnapshot();
    if (error) return fail(error);
    store.open("summary");
    return ok("Recording stopped. The Profiler shows its Summary.");
  }
  await store.captureFrame();
  const { error } = store.getSnapshot();
  return error ? fail(error) : ok("Frame captured. The Profiler shows its Frame Report.");
}

/** The game's `help` list, with the Profiler commands the editor runs added under their own heading. */
export function withProfilerHelp(line: string, result: CommandResult): CommandResult {
  const tokens = tokenize(line);
  if (!result.success || tokens.length !== 1 || tokens[0]!.toLowerCase() !== "help") return result;
  const rows = [...PROFILER_CONSOLE_COMMANDS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => `  ${command.name} — ${command.description}`);
  return { ...result, output: [result.output, "profiler:", ...rows].filter(Boolean).join("\n") };
}
