import type { LogSeverity } from "./log-ring";

type ConsoleTarget = Pick<Console, "log" | "info" | "debug" | "warn" | "error">;

function formatConsoleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return String(item);
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
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
