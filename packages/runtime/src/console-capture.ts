import type { LogSeverity } from "./log-ring";

type ConsoleTarget = Pick<Console, "log" | "info" | "debug" | "warn" | "error">;

/**
 * About how many characters one formatted value may reach before further objects print as
 * "[Truncated]". A shared value prints once per path to it, so without a bound a value reached
 * along exponentially many paths would grow without limit.
 */
const FORMATTED_VALUE_BUDGET = 1_000_000;

function formatConsoleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  try {
    // The objects that contain the one being written; a value shared by two properties is no cycle.
    const ancestors: object[] = [];
    let written = 0;
    return JSON.stringify(value, function (this: unknown, key: string, raw: unknown) {
      const item = typeof raw === "bigint" ? String(raw) : raw;
      // Rough length of this entry: its key, quotes and separators, and a string's text.
      written += key.length + 4 + (typeof item === "string" ? item.length : 4);
      if (item && typeof item === "object") {
        if (written > FORMATTED_VALUE_BUDGET) return "[Truncated]";
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(item)) return "[Circular]";
        ancestors.push(item);
      }
      return item;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Capture native script/engine console output for one Play host lifetime. */
export function captureConsoleLogs(
  target: ConsoleTarget,
  receive: (message: string, severity: LogSeverity) => void,
): () => void {
  const levels = { log: "log", info: "log", debug: "verbose", warn: "warning", error: "error" } as const;
  const cleanups: Array<() => void> = [];
  let forwarding = false;
  let active = true;
  for (const method of Object.keys(levels) as Array<keyof typeof levels>) {
    const original = target[method];
    const wrapped = (...values: unknown[]) => {
      original.apply(target, values);
      if (!active || forwarding) return;
      forwarding = true;
      try {
        receive(values.map(formatConsoleValue).join(" "), levels[method]);
      } finally {
        forwarding = false;
      }
    };
    target[method] = wrapped;
    cleanups.push(() => {
      if (target[method] === wrapped) target[method] = original;
    });
  }
  return () => {
    active = false;
    for (const cleanup of cleanups) cleanup();
  };
}
