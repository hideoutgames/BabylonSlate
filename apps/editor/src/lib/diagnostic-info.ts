import { getApplicationVersion } from "./changelog";

/** Device facts that help reproduce a report; never includes project content or identifiers. */
export interface DiagnosticEnvironment {
  appVersion: string;
  buildLabel?: string;
  userAgent: string;
  platform: string;
  touchPoints: number;
  devicePixelRatio: number;
  screen: string;
  viewport: string;
  cores: number | null;
  memoryGb: number | null;
}

export function collectDiagnosticEnvironment(appVersion = getApplicationVersion(), buildLabel?: string): DiagnosticEnvironment {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string }; deviceMemory?: number };
  return {
    appVersion,
    buildLabel,
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform || nav.platform || "unknown",
    touchPoints: nav.maxTouchPoints ?? 0,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${window.screen.width}x${window.screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    cores: nav.hardwareConcurrency || null,
    memoryGb: nav.deviceMemory ?? null,
  };
}

export function clipText(text: string, max = 240): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function formatDiagnosticEnvironment(environment: DiagnosticEnvironment): string[] {
  return [
    `App: ${environment.appVersion || "dev"}${environment.buildLabel ? ` (${environment.buildLabel})` : ""}`,
    `Device: ${environment.platform} · touch ${environment.touchPoints} · DPR ${environment.devicePixelRatio} · screen ${environment.screen} · viewport ${environment.viewport} · cores ${environment.cores ?? "?"} · memory ${environment.memoryGb === null ? "?" : `${environment.memoryGb} GB`}`,
    `Browser: ${clipText(environment.userAgent, 300)}`,
  ];
}

/** Message, first stack frames, and every `cause` / AggregateError member, one line each. */
export function describeError(error: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  const indent = "  ".repeat(depth);
  if (!(error instanceof Error)) return [`${indent}${clipText(String(error), 600)}`];
  const lines = [`${indent}${error.name}: ${clipText(error.message, 600)}`];
  for (const frame of (error.stack ?? "").split("\n").slice(1, 9)) {
    const trimmed = frame.trim();
    if (trimmed) lines.push(`${indent}  ${clipText(trimmed, 200)}`);
  }
  if (error instanceof AggregateError) {
    for (const member of error.errors.slice(0, 5)) lines.push(...describeError(member, depth + 1));
  }
  if (error.cause !== undefined) {
    lines.push(`${indent}Caused by:`);
    lines.push(...describeError(error.cause, depth + 1));
  }
  return lines;
}

type LogEntry = { time: number; level: "error" | "warn"; text: string };
const LOG_CAP = 60;
const recent: LogEntry[] = [];
let installs = 0;
let restore: (() => void) | null = null;

function record(level: LogEntry["level"], args: unknown[]): void {
  const text = args.map((arg) => arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === "string" ? arg : (() => {
    try { return JSON.stringify(arg); } catch { return String(arg); }
  })()).join(" ");
  recent.push({ time: Date.now(), level, text: clipText(text, 400) });
  if (recent.length > LOG_CAP) recent.splice(0, recent.length - LOG_CAP);
}

/**
 * Keeps the newest console errors/warnings and uncaught errors for copied
 * reports. Reference counted; the original console methods still run.
 */
export function installDiagnosticLog(): () => void {
  installs += 1;
  if (installs === 1) {
    const { error, warn } = console;
    console.error = (...args: unknown[]) => { record("error", args); error.apply(console, args); };
    console.warn = (...args: unknown[]) => { record("warn", args); warn.apply(console, args); };
    const onError = (event: ErrorEvent) => record("error", [event.error ?? event.message]);
    const onRejection = (event: PromiseRejectionEvent) => record("error", ["Unhandled rejection:", event.reason]);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    restore = () => {
      console.error = error;
      console.warn = warn;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs === 0) { restore?.(); restore = null; }
  };
}

/** The newest recorded console errors/warnings, oldest first, as report lines. */
export function recentDiagnosticLog(limit = 20): string[] {
  return recent.slice(-limit).map((entry) => `[${entry.level}] ${new Date(entry.time).toISOString().slice(11, 19)} ${entry.text}`);
}

/**
 * Copies `text` inside the current user gesture. iPad Safari rejects a
 * clipboard write that starts after an await, so callers build text first.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { area.remove(); }
  }
}
