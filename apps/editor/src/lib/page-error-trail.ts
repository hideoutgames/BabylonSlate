import { recordSessionTrailEvent, SessionTrailEventKind } from "@haptic/core";

/** Stack lines an event keeps after the error's own line. */
const STACK_LINES = 4;
/** Each kept stack line is cut to this many characters. */
const STACK_LINE_CHARS = 160;

/**
 * An error as the session trail records it: its name and message, then the first few lines of its stack (bounded), or
 * where it was thrown when it has none.
 */
export function describeError(error: unknown, where?: string): string {
  if (!(error instanceof Error)) return `${String(error)}${where ? ` (${where})` : ""}`;
  const head = `${error.name}: ${error.message}`;
  const stack = (error.stack ?? "").split("\n").map((line) => line.trim())
    // V8 repeats the name and message as the stack's first line.
    .filter((line) => line && line !== head && !line.startsWith(`${error.name}:`))
    .slice(0, STACK_LINES)
    .map((line) => (line.length > STACK_LINE_CHARS ? `${line.slice(0, STACK_LINE_CHARS - 1)}…` : line));
  if (stack.length) return [head, ...stack].join(" | ");
  return `${head}${where ? ` (${where})` : ""}`;
}

/** Component stack lines an error screen's event keeps. */
const COMPONENT_STACK_LINES = 3;

/**
 * Records that an error screen (`title`, as the user sees it) was shown for `error`: an error boundary's
 * `componentDidCatch`, with the head of React's component stack when it has one, or a red error message the editor
 * shows.
 */
export function recordErrorScreen(title: string, error: unknown, info?: { componentStack?: string | null }): void {
  try {
    const components = (info?.componentStack ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
      .slice(0, COMPONENT_STACK_LINES).join(" < ");
    // The component stack goes before the error's own stack, which the detail's bound cuts first.
    const [head, ...stack] = describeError(error).split(" | ");
    recordSessionTrailEvent(SessionTrailEventKind.errorScreen, [`${title}: ${head}`, ...(components ? [`in ${components}`] : []), ...stack].join(" | "));
  } catch {
    // Recording must never break the screen that shows the error.
  }
}

/** What failed to load, for an `error` event whose target is an element (a script, stylesheet or image). */
function describeResource(target: Element): string {
  const url = target.getAttribute("src") ?? target.getAttribute("href") ?? (target as { currentSrc?: string }).currentSrc ?? "";
  return `<${target.tagName.toLowerCase()}> ${url || "(no URL)"}`;
}

/**
 * Records every uncaught error, unhandled rejection and failed resource load of the page in the session trail, as it
 * happens, so the next report can tell what came before a page that stopped. Listens in the capture phase, where a
 * resource's load error (which does not bubble) reaches the window. Records only: the events go on as before. Returns
 * what stops it (tests).
 */
export function installPageErrorTrail(target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  const onError = (event: Event) => {
    try {
      const element = event.target;
      if (typeof Element !== "undefined" && element instanceof Element) {
        recordSessionTrailEvent(SessionTrailEventKind.resource, describeResource(element));
        return;
      }
      const error = event as ErrorEvent;
      const where = error.filename ? `${error.filename}:${error.lineno ?? 0}:${error.colno ?? 0}` : undefined;
      recordSessionTrailEvent(SessionTrailEventKind.error, error.error !== undefined && error.error !== null
        ? describeError(error.error, where)
        : `${error.message || "an error without a message"}${where ? ` (${where})` : ""}`);
    } catch {
      // Recording must never add an error of its own.
    }
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    try {
      recordSessionTrailEvent(SessionTrailEventKind.rejection, describeError(event.reason));
    } catch {
      // As above.
    }
  };
  target.addEventListener("error", onError, true);
  target.addEventListener("unhandledrejection", onRejection as EventListener);
  return () => {
    target.removeEventListener("error", onError, true);
    target.removeEventListener("unhandledrejection", onRejection as EventListener);
  };
}
