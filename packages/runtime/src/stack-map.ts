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

const V8_FRAME =
  /^\s*at\s+(?:(.+?)\s+\()?((?:babylonslate:|blob:|file:|https?:)[^):]+):(\d+):(\d+)\)?\s*$/;
const WEBKIT_FRAME =
  /^(?:(.*)@)?((?:babylonslate:|blob:|file:|https?:)[^:]+):(\d+):(\d+)\s*$/;

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
  const match = url.match(/^babylonslate:\/\/\/([^/?#]+?)(?:\.js)?$/);
  return match ? match[1]! : null;
}

export function mapStackToAnchor(
  stack: string,
  tables: ReadonlyMap<string, readonly AnchorEntry[]>,
): AnchorEntry | null {
  for (const frame of parseStackFrames(stack)) {
    const guid = assetGuidFromSourceUrl(frame.url);
    if (!guid) continue;
    const table = tables.get(guid);
    if (!table) continue;
    const hit = lookupAnchor(table, frame.line, frame.column);
    if (hit) return hit;
  }
  return null;
}
