/**
 * The shape of a script wire, shared by every place that draws or samples one: the edges, the
 * live and pending connection wires, connection previews and the formatter.
 *
 * A wire running forwards (target right of source) leaves its pin level, eases once between the
 * two heights, and enters its pin level. The ease is a symmetric S, horizontal at both ends, whose
 * two halves mirror each other about its midpoint, and it sits centred on the wire. Its span
 * across depends only on the change of height, so wires between the same columns ease alike and
 * run parallel; a wire shorter than that span eases along its whole length. A level wire is a
 * straight line. A wire running backwards keeps XYFlow's loop.
 */

/** Span across of an ease per unit of height it changes. */
export const WIRE_EASE_PER_HEIGHT = 1.2;
/** Shortest ease, so a small offset does not kink. */
export const WIRE_EASE_MIN = 48;
/** Longest ease, so a large drop stays a short transition. */
export const WIRE_EASE_MAX = 200;
// XYFlow's curvature, kept for wires that run backwards.
const BACKWARD_CURVATURE = 0.25;

export type WirePoint = { x: number; y: number };

/** The ease of a forward wire as [start x, end x], or null for a level or backward wire. */
export function graphWireEase(sourceX: number, sourceY: number, targetX: number, targetY: number): [number, number] | null {
  const dx = targetX - sourceX;
  const dy = Math.abs(targetY - sourceY);
  if (dx < 0 || dy === 0) return null;
  const span = Math.min(dx, Math.min(WIRE_EASE_MAX, Math.max(WIRE_EASE_MIN, dy * WIRE_EASE_PER_HEIGHT)));
  const start = sourceX + (dx - span) / 2;
  return [start, start + span];
}

function backwardOffset(sourceX: number, targetX: number): number {
  return BACKWARD_CURVATURE * 25 * Math.sqrt(sourceX - targetX);
}

/**
 * SVG path and label data of a wire from a right-facing source pin to a left-facing target pin,
 * in the tuple `getBezierPath` returns: [path, labelX, labelY, offsetX, offsetY].
 */
export function graphWirePath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): [path: string, labelX: number, labelY: number, offsetX: number, offsetY: number] {
  const labelX = (sourceX + targetX) / 2;
  const labelY = (sourceY + targetY) / 2;
  const offsetX = Math.abs(labelX - sourceX);
  const offsetY = Math.abs(labelY - sourceY);
  if (targetX < sourceX) {
    const offset = backwardOffset(sourceX, targetX);
    const path = `M${sourceX},${sourceY} C${sourceX + offset},${sourceY} ${targetX - offset},${targetY} ${targetX},${targetY}`;
    // The loop's point halfway along its parameter, as XYFlow labels it.
    const x = sourceX * 0.125 + (sourceX + offset) * 0.375 + (targetX - offset) * 0.375 + targetX * 0.125;
    return [path, x, labelY, Math.abs(x - sourceX), offsetY];
  }
  const ease = graphWireEase(sourceX, sourceY, targetX, targetY);
  if (!ease) return [`M${sourceX},${sourceY} L${targetX},${targetY}`, labelX, labelY, offsetX, offsetY];
  const [start, end] = ease;
  const middle = (start + end) / 2;
  const path =
    `M${sourceX},${sourceY} L${start},${sourceY} ` +
    `C${middle},${sourceY} ${middle},${targetY} ${end},${targetY} L${targetX},${targetY}`;
  return [path, labelX, labelY, offsetX, offsetY];
}

/**
 * Points along a wire as `graphWirePath` draws it: the ends of its level stubs and `samples`
 * points along its ease (or its loop), source to target, ends included.
 */
export function sampleGraphWire(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  samples: number,
): WirePoint[] {
  const points: WirePoint[] = [];
  if (targetX < sourceX) {
    const offset = backwardOffset(sourceX, targetX);
    for (let index = 0; index <= samples; index++) {
      const t = index / samples;
      const u = 1 - t;
      points.push({
        x: u * u * u * sourceX + 3 * u * u * t * (sourceX + offset) + 3 * u * t * t * (targetX - offset) + t * t * t * targetX,
        y: sourceY + (targetY - sourceY) * (3 * u * t * t + t * t * t),
      });
    }
    return points;
  }
  const ease = graphWireEase(sourceX, sourceY, targetX, targetY);
  if (!ease) return [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }];
  const [start, end] = ease;
  const span = end - start;
  if (start > sourceX) points.push({ x: sourceX, y: sourceY });
  for (let index = 0; index <= samples; index++) {
    const t = index / samples;
    const u = 1 - t;
    // Both control points sit at the ease's middle: x and y are mirror-symmetric about t = ½.
    points.push({
      x: start + span * (1.5 * t * u + t * t * t),
      y: sourceY + (targetY - sourceY) * (3 * t * t - 2 * t * t * t),
    });
  }
  if (end < targetX) points.push({ x: targetX, y: targetY });
  return points;
}
