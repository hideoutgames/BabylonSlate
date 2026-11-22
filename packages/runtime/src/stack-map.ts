export interface StackFrame {
  functionName: string;
  url: string;
  line: number;
  column: number;
}

export interface AnchorEntry {
  line: number;
  column: number;
  assetGuid: string;
  graphId: string;
  nodeId: string;
  bodyLine?: number;
  btNodeId?: string;
}

// Any URL scheme: Editor Play's `haptic:`, and a game's scripts module over `https:`, `blob:` (Preview Build), `file:`,
// `app:` (desktop) or `capacitor:` (iOS).
const V8_FRAME =
  /^\s*at\s+(?:(.+?)\s+\()?([a-zA-Z][\w+.-]*:.+?):(\d+):(\d+)\)?\s*$/;
const WEBKIT_FRAME =
  /^(?:(.*)@)?([a-zA-Z][\w+.-]*:.+?):(\d+):(\d+)\s*$/;

export function parseStackFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("Error")) continue;
    let match = line.match(V8_FRAME);
    if (match) {
      frames.push({
        functionName: match[1] ?? "",
        url: match[2]!,
        line: Number(match[3]),
        column: Number(match[4]),
      });
      continue;
    }
    match = line.match(WEBKIT_FRAME);
    if (match) {
      frames.push({
        functionName: match[1] ?? "",
        url: match[2]!,
        line: Number(match[3]),
        column: Number(match[4]),
      });
    }
  }
  return frames;
}

/** Binary search for the nearest preceding anchor by line (then column). */
export function lookupAnchor(
  anchors: readonly AnchorEntry[],
  line: number,
  column: number,
): AnchorEntry | null {
  let lo = 0;
  let hi = anchors.length - 1;
  let best: AnchorEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = anchors[mid]!;
    if (a.line < line || (a.line === line && a.column <= column)) {
      best = a;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export function assetGuidFromSourceUrl(url: string): string | null {
  const match = url.match(/^haptic:\/\/\/([^/?#]+?)(?:\.js)?$/);
  return match ? match[1]! : null;
}

/**
 * The anchor of the innermost frame in a compiled script: a `haptic:///<label>.js` source's own table, or the table of a
 * file holding several scripts (an exported game's scripts module), keyed by its URL, where an entry with no node
 * marks where a script starts.
 */
export function mapStackToAnchor(
  stack: string,
  tables: ReadonlyMap<string, readonly AnchorEntry[]>,
): AnchorEntry | null {
  for (const frame of parseStackFrames(stack)) {
    const table = tables.get(assetGuidFromSourceUrl(frame.url) ?? frame.url);
    if (!table) continue;
    const hit = lookupAnchor(table, frame.line, frame.column);
    if (hit?.nodeId) return hit;
  }
  return null;
}
