export type OutputLogSeverity = "error" | "warning" | "info";

export interface OutputLogEntry {
  severity: OutputLogSeverity;
  /** Leading `[Source]` tag, without brackets. */
  source: string | null;
  message: string;
}

const SOURCE_TAG = /^\[([^\]]+)\]\s*/;
const WARNING = /\bwarn(?:ing)?s?\b/i;
const ERROR = /\b(?:fail(?:ed|s|ure)?|errors?|exception|could not|cannot)\b/i;

/**
 * Output Log lines are plain strings; severity is inferred from their wording
 * so the panel can mark problems without changing every log producer.
 */
export function parseOutputLogLine(line: string): OutputLogEntry {
  const tag = SOURCE_TAG.exec(line);
  const source = tag ? tag[1]!.trim() : null;
  const message = tag ? line.slice(tag[0].length) : line;
  const severity: OutputLogSeverity = WARNING.test(message)
    ? "warning"
    : ERROR.test(message)
      ? "error"
      : "info";
  return { severity, source, message };
}

const SEVERITY_PREFIX: Readonly<Record<string, string>> = {
  verbose: "Verbose: ",
  warning: "Warning: ",
  error: "Error: ",
};

/**
 * A runtime log command (a Log node, or a log the runtime itself raises) as an
 * Output Log line: its category as the source tag, and the severity named in the
 * message unless it is the default Log, so the panel's wording inference marks it.
 */
export function formatRuntimeLogLine(entry: { category: string; severity: string; message: string }): string {
  const tag = entry.category ? `[${entry.category}] ` : "";
  return `${tag}${SEVERITY_PREFIX[entry.severity] ?? ""}${entry.message}`;
}
