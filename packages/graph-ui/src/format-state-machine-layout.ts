import type { FormatLayoutBox, FormatLayoutNode, GraphFormatLayout } from "./format-layout";
import { animTransitionCurveBetween, type AnimStateSide, type AnimTransitionCurve } from "./anim-transition-path";

/** Room between layer columns: both wire stubs (64 each), the badge between them and the arrowheads stay clear. */
export const FORMAT_STATE_LAYER_GAP = 176;
/** Room between states stacked in one layer, enough for a transition between neighbours to read. */
export const FORMAT_STATE_GAP = 72;
/** The least room a drawn transition keeps from every state it does not connect. */
export const FORMAT_TRANSITION_CLEARANCE = 32;
/** One transition too close to a third state costs as much as this many crossings. */
const OBSTRUCTION_COST = 3;
/** Ordering rounds; each must strictly lower the cost, so this only bounds the work. */
const MAX_ORDER_ROUNDS = 32;
/** Points sampled along a transition's curve to measure its distance from states. */
const CURVE_SAMPLES = 24;

export type FormatStateMachineLayoutOptions = {
  /** The state the machine starts in: layer 0, and the whole-machine layout keeps its position. */
  entryId?: string;
  /**
   * For a node that stands for other states (a State Alias, whose transitions leave from each of them), the states it
   * stands for. It is laid out one layer after the nearest of them; nothing is drawn into it.
   */
  aliasStates?: (node: FormatLayoutNode) => readonly string[] | undefined;
  layerGap?: number;
  stateGap?: number;
};

type Segment = { from: string; to: string };
type Point = { x: number; y: number };

/**
 * The sides a transition between two states uses after Format: between states in different columns (boxes that do
 * not overlap across), the facing left and right sides; within one column, the facing top and bottom sides. The rule
 * is symmetric, so a pair of opposite transitions takes mirrored sides and draws as one wire. Hosts apply it to the
 * transitions Format lays out, so the layout measures the wires the editor draws.
 */
export function formatStateMachineSides(
  from: FormatLayoutBox,
  to: FormatLayoutBox,
): { source: AnimStateSide; target: AnimStateSide } {
  if (from.x + from.width <= to.x) return { source: "right", target: "left" };
  if (to.x + to.width <= from.x) return { source: "left", target: "right" };
  return from.y + from.height / 2 <= to.y + to.height / 2
    ? { source: "bottom", target: "top" }
    : { source: "top", target: "bottom" };
}

/** The curve Format's sides give a transition between two boxes. */
export function formatStateMachineCurve(from: FormatLayoutBox, to: FormatLayoutBox): AnimTransitionCurve {
  const sides = formatStateMachineSides(from, to);
  return animTransitionCurveBetween(from, sides.source, to, sides.target);
}

/**
 * A layered left-to-right State Machine. Layer 0 is the entry; every other state sits at its shortest distance in
 * transitions from it (BFS), so back transitions and cycles never stretch the graph. A state the entry cannot reach
 * that leads into the layered states sits one layer before the earliest state it leads to (left of the entry when
 * that is the entry), so its transitions run short and forward; states with no transition into the layers go in one
 * row below, in their current left-to-right order.
 *
 * States are stacked per layer, each layer centred on the graph's vertical middle, in the order that gives the fewest
 * crossings and transitions passing within `FORMAT_TRANSITION_CLEARANCE` of a third state, measured on the curve the
 * editor draws with `formatStateMachineSides` (barycentre sweeps and neighbour swaps, each step kept only when it
 * lowers that count, from the states' current top-to-bottom order). A transition still too close to a third state
 * then moves that state, with the states beyond it in its layer, up or down until the curve clears it.
 *
 * Scope: two or more selected nodes lay out only those, as their own block at the top-left of their current bounds
 * (layer 0 is the entry when selected, else the selected states nothing selected leads into); otherwise the whole
 * machine, with the entry keeping its position. Every node passed takes part as a state. Deterministic and
 * idempotent: the order only changes when it lowers the count, so a second Format moves nothing.
 */
export function formatStateMachineLayout(
  input: Parameters<GraphFormatLayout>[0],
  options: FormatStateMachineLayoutOptions = {},
): ReturnType<GraphFormatLayout> {
  const layerGap = options.layerGap ?? FORMAT_STATE_LAYER_GAP;
  const stateGap = options.stateGap ?? FORMAT_STATE_GAP;
  const allById = new Map(input.nodes.map((node) => [node.id, node]));
  const selected = input.selectedIds.filter((id) => allById.has(id));
  const partial = selected.length >= 2;
  const scope = partial ? selected.map((id) => allById.get(id)!) : input.nodes;
  if (scope.length === 0) return [];
  const byId = new Map(scope.map((node) => [node.id, node]));

  const segments: Segment[] = [];
  const seenPairs = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of input.edges) {
    if (edge.source === edge.target || !byId.has(edge.source) || !byId.has(edge.target)) continue;
    const key = edge.source < edge.target ? `${edge.source}\0${edge.target}` : `${edge.target}\0${edge.source}`;
    if (!seenPairs.has(key)) {
      seenPairs.add(key);
      segments.push({ from: edge.source, to: edge.target });
    }
    const list = outgoing.get(edge.source) ?? [];
    if (!list.includes(edge.target)) list.push(edge.target);
    outgoing.set(edge.source, list);
    hasIncoming.add(edge.target);
  }
  const aliasesOf = new Map<string, string[]>();
  for (const node of scope) {
    for (const stateId of options.aliasStates?.(node) ?? []) {
      if (stateId === node.id || !byId.has(stateId)) continue;
      const list = aliasesOf.get(stateId) ?? [];
      list.push(node.id);
      aliasesOf.set(stateId, list);
      hasIncoming.add(node.id);
    }
  }

  // Layers: shortest distance in transitions from the seeds.
  const entry = options.entryId !== undefined ? byId.get(options.entryId) : undefined;
  let seeds: FormatLayoutNode[];
  if (entry) seeds = [entry];
  else {
    seeds = scope.filter((node) => !hasIncoming.has(node.id));
    if (seeds.length === 0) seeds = [[...scope].sort(topLeftFirst)[0]!];
  }
  const layerOf = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seeds) {
    layerOf.set(seed.id, 0);
    queue.push(seed.id);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    const next = layerOf.get(id)! + 1;
    for (const target of [...(outgoing.get(id) ?? []), ...(aliasesOf.get(id) ?? [])]) {
      if (layerOf.has(target)) continue;
      layerOf.set(target, next);
      queue.push(target);
    }
  }
  // States that only lead into the layers: one layer before the earliest state they lead to.
  for (let changed = true; changed; ) {
    changed = false;
    for (const node of scope) {
      if (layerOf.has(node.id)) continue;
      let earliest = Infinity;
      for (const target of outgoing.get(node.id) ?? []) {
        const layer = layerOf.get(target);
        if (layer !== undefined) earliest = Math.min(earliest, layer);
      }
      if (earliest === Infinity) continue;
      layerOf.set(node.id, earliest - 1);
      changed = true;
    }
  }
  let firstLayer = 0;
  for (const layer of layerOf.values()) firstLayer = Math.min(firstLayer, layer);
  const layers: FormatLayoutNode[][] = [];
  const unreachable: FormatLayoutNode[] = [];
  for (const node of scope) {
    const layer = layerOf.get(node.id);
    if (layer === undefined) unreachable.push(node);
    else (layers[layer - firstLayer] ??= []).push(node);
  }
  for (const layer of layers) layer.sort(topFirst);
  unreachable.sort(leftFirst);

  const layered = segments.filter((segment) => layerOf.has(segment.from) && layerOf.has(segment.to));
  const geometry = new LayeredGeometry(layers, layered, layerGap, stateGap);
  geometry.order();
  geometry.clearTransitions();

  // The unreachable row below the layered block.
  const relative = geometry.positions;
  let bottom = -Infinity;
  let left = Infinity;
  for (const node of layers.flat()) {
    const position = relative.get(node.id)!;
    bottom = Math.max(bottom, position.y + node.height);
    left = Math.min(left, position.x);
  }
  if (!Number.isFinite(left)) {
    left = 0;
    bottom = -2 * stateGap;
  }
  let rowX = left;
  for (const node of unreachable) {
    relative.set(node.id, { x: rowX, y: bottom + 2 * stateGap });
    rowX += node.width + layerGap;
  }

  // Anchor: the entry keeps its place for the whole machine; a selection keeps its bounds' top-left.
  let dx: number;
  let dy: number;
  const anchor = !partial && entry ? relative.get(entry.id) : undefined;
  if (anchor && entry) {
    dx = entry.position.x - anchor.x;
    dy = entry.position.y - anchor.y;
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let fromX = Infinity;
    let fromY = Infinity;
    for (const node of scope) {
      const position = relative.get(node.id)!;
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      fromX = Math.min(fromX, node.position.x);
      fromY = Math.min(fromY, node.position.y);
    }
    dx = fromX - minX;
    dy = fromY - minY;
  }
  return scope.map((node) => {
    const position = relative.get(node.id)!;
    return { id: node.id, position: { x: Math.round(position.x + dx), y: Math.round(position.y + dy) } };
  });
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function topFirst(a: FormatLayoutNode, b: FormatLayoutNode): number {
  return a.position.y + a.height / 2 - (b.position.y + b.height / 2) || compareIds(a.id, b.id);
}

function leftFirst(a: FormatLayoutNode, b: FormatLayoutNode): number {
  return a.position.x - b.position.x || a.position.y - b.position.y || compareIds(a.id, b.id);
}

function topLeftFirst(a: FormatLayoutNode, b: FormatLayoutNode): number {
  return a.position.y - b.position.y || leftFirst(a, b);
}

/** The layered block: per-layer order, the positions it gives, and the count that orders it. */
class LayeredGeometry {
  readonly positions = new Map<string, { x: number; y: number }>();
  private readonly nodes = new Map<string, FormatLayoutNode>();
  private readonly layerIndex = new Map<string, number>();
  private readonly columnX: number[] = [];
  private readonly columnWidth: number[] = [];
  /** Indexes into `segments` of the transitions at each state. */
  private readonly touching = new Map<string, number[]>();
  private readonly layers: FormatLayoutNode[][];
  private readonly segments: readonly Segment[];
  private readonly stateGap: number;

  constructor(layers: FormatLayoutNode[][], segments: readonly Segment[], layerGap: number, stateGap: number) {
    this.layers = layers;
    this.segments = segments;
    this.stateGap = stateGap;
    let x = 0;
    layers.forEach((layer, index) => {
      let width = 0;
      for (const node of layer) {
        this.nodes.set(node.id, node);
        this.layerIndex.set(node.id, index);
        width = Math.max(width, node.width);
      }
      this.columnX[index] = x;
      this.columnWidth[index] = width;
      x += width + layerGap;
    });
    segments.forEach((segment, index) => {
      for (const id of [segment.from, segment.to]) {
        const list = this.touching.get(id) ?? [];
        list.push(index);
        this.touching.set(id, list);
      }
    });
    for (let index = 0; index < layers.length; index += 1) this.placeLayer(index);
  }

  /** Stacks a layer in its order, centred on the block's vertical middle. */
  private placeLayer(index: number): void {
    const layer = this.layers[index]!;
    let height = Math.max(0, layer.length - 1) * this.stateGap;
    for (const node of layer) height += node.height;
    let y = -height / 2;
    for (const node of layer) {
      this.positions.set(node.id, { x: this.columnX[index]! + (this.columnWidth[index]! - node.width) / 2, y });
      y += node.height + this.stateGap;
    }
  }

  private centre(id: string): Point {
    const node = this.nodes.get(id)!;
    const position = this.positions.get(id)!;
    return { x: position.x + node.width / 2, y: position.y + node.height / 2 };
  }

  private box(id: string): FormatLayoutBox {
    const node = this.nodes.get(id)!;
    const position = this.positions.get(id)!;
    return { x: position.x, y: position.y, width: node.width, height: node.height };
  }

  /** The drawn transition, sampled as a polyline. */
  private curve(segment: Segment): Point[] {
    return sampleCurve(formatStateMachineCurve(this.box(segment.from), this.box(segment.to)));
  }

  private crosses(a: Segment, b: Segment): boolean {
    if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) return false;
    return segmentsCross(this.centre(a.from), this.centre(a.to), this.centre(b.from), this.centre(b.to));
  }

  private tooClose(segment: Segment, curve: readonly Point[], id: string): boolean {
    if (segment.from === id || segment.to === id) return false;
    return polylineBoxDistance(curve, this.box(id)) < FORMAT_TRANSITION_CLEARANCE;
  }

  /** Crossings plus weighted transitions too close to a third state, over the whole block. */
  cost(): number {
    let total = 0;
    for (let i = 0; i < this.segments.length; i += 1) {
      const segment = this.segments[i]!;
      for (let j = i + 1; j < this.segments.length; j += 1) {
        if (this.crosses(segment, this.segments[j]!)) total += 1;
      }
      const curve = this.curve(segment);
      for (const id of this.nodes.keys()) {
        if (this.tooClose(segment, curve, id)) total += OBSTRUCTION_COST;
      }
    }
    return total;
  }

  /** The part of the cost that moving only `a` and `b` can change. */
  private localCost(a: string, b: string): number {
    const mine = new Set<number>([...(this.touching.get(a) ?? []), ...(this.touching.get(b) ?? [])]);
    let total = 0;
    for (const index of mine) {
      const segment = this.segments[index]!;
      this.segments.forEach((other, otherIndex) => {
        if (otherIndex === index || (mine.has(otherIndex) && otherIndex < index)) return;
        if (this.crosses(segment, other)) total += 1;
      });
      const curve = this.curve(segment);
      for (const id of this.nodes.keys()) {
        if (this.tooClose(segment, curve, id)) total += OBSTRUCTION_COST;
      }
    }
    this.segments.forEach((segment, index) => {
      if (mine.has(index)) return;
      const curve = this.curve(segment);
      if (this.tooClose(segment, curve, a)) total += OBSTRUCTION_COST;
      if (this.tooClose(segment, curve, b)) total += OBSTRUCTION_COST;
    });
    return total;
  }

  /** Orders every layer: barycentre sweeps and neighbour swaps, each kept only when it lowers the cost. */
  order(): void {
    let cost = this.cost();
    for (let round = 0; round < MAX_ORDER_ROUNDS; round += 1) {
      let improved = false;
      const before = this.layers.map((layer) => [...layer]);
      this.sweep();
      const swept = this.cost();
      if (swept < cost) {
        cost = swept;
        improved = true;
      } else {
        this.layers.forEach((layer, index) => layer.splice(0, layer.length, ...before[index]!));
        for (let index = 0; index < this.layers.length; index += 1) this.placeLayer(index);
      }
      const swapped = this.transpose();
      if (swapped < 0) {
        cost += swapped;
        improved = true;
      }
      if (!improved) return;
    }
  }

  /** One barycentre sweep down the layers, then one up. */
  private sweep(): void {
    const rank = (id: string) => {
      const layer = this.layers[this.layerIndex.get(id)!]!;
      return layer.findIndex((node) => node.id === id) - (layer.length - 1) / 2;
    };
    const reorder = (index: number, before: boolean) => {
      const layer = this.layers[index]!;
      const keys = new Map<string, number>();
      for (const node of layer) {
        let sum = 0;
        let count = 0;
        for (const segmentIndex of this.touching.get(node.id) ?? []) {
          const segment = this.segments[segmentIndex]!;
          const other = segment.from === node.id ? segment.to : segment.from;
          const otherLayer = this.layerIndex.get(other)!;
          if (before ? otherLayer < index : otherLayer > index) {
            sum += rank(other);
            count += 1;
          }
        }
        keys.set(node.id, count > 0 ? sum / count : rank(node.id));
      }
      const current = new Map(layer.map((node, position) => [node.id, position]));
      layer.sort((a, b) => keys.get(a.id)! - keys.get(b.id)! || current.get(a.id)! - current.get(b.id)!);
      this.placeLayer(index);
    };
    for (let index = 1; index < this.layers.length; index += 1) reorder(index, true);
    for (let index = this.layers.length - 2; index >= 0; index -= 1) reorder(index, false);
  }

  /** Swaps neighbours in a layer wherever that lowers the cost; returns the total change (≤ 0). */
  private transpose(): number {
    let total = 0;
    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index]!;
      for (let position = 0; position + 1 < layer.length; position += 1) {
        const a = layer[position]!;
        const b = layer[position + 1]!;
        const before = this.localCost(a.id, b.id);
        layer[position] = b;
        layer[position + 1] = a;
        this.placeLayer(index);
        const delta = this.localCost(a.id, b.id) - before;
        if (delta < 0) {
          total += delta;
        } else {
          layer[position] = a;
          layer[position + 1] = b;
          this.placeLayer(index);
        }
      }
    }
    return total;
  }

  /**
   * A transition still within the clearance of a third state moves that state out of its way, with the states
   * beyond it in its layer: down below the curve or up above it, whichever is shorter and leaves the transition's own
   * states where they are. Repeats until every curve clears, within a bound.
   */
  clearTransitions(): void {
    if (this.segments.length === 0) return;
    const rounds = 4 * this.nodes.size + 8;
    for (let round = 0; round < rounds; round += 1) {
      let moved = false;
      for (const segment of this.segments) {
        for (const id of this.nodes.keys()) {
          const curve = this.curve(segment);
          if (!this.tooClose(segment, curve, id)) continue;
          const layer = this.layers[this.layerIndex.get(id)!]!;
          const position = layer.findIndex((node) => node.id === id);
          const box = this.box(id);
          const span = curveYSpan(curve, box.x - FORMAT_TRANSITION_CLEARANCE, box.x + box.width + FORMAT_TRANSITION_CLEARANCE);
          const below = layer.slice(position);
          const above = layer.slice(0, position + 1);
          const ends = (group: FormatLayoutNode[]) => group.some((node) => node.id === segment.from || node.id === segment.to);
          const down = ends(below) ? Infinity : span.max + FORMAT_TRANSITION_CLEARANCE + 1 - box.y;
          const up = ends(above) ? Infinity : box.y + box.height - (span.min - FORMAT_TRANSITION_CLEARANCE - 1);
          if (down === Infinity && up === Infinity) continue;
          if (down <= up) for (const node of below) this.positions.get(node.id)!.y += down;
          else for (const node of above) this.positions.get(node.id)!.y -= up;
          moved = true;
        }
      }
      if (!moved) return;
    }
  }
}

function sampleCurve(curve: AnimTransitionCurve): Point[] {
  const points: Point[] = [];
  const { source: p0, sourceControl: p1, targetControl: p2, target: p3 } = curve;
  for (let step = 0; step <= CURVE_SAMPLES; step += 1) {
    const t = step / CURVE_SAMPLES;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return points;
}

/** The curve's lowest and highest y over x in [x0, x1], or over its point nearest that range when none falls in it. */
function curveYSpan(curve: readonly Point[], x0: number, x1: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i + 1 < curve.length; i += 1) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    const lo = Math.max(x0, Math.min(a.x, b.x));
    const hi = Math.min(x1, Math.max(a.x, b.x));
    if (lo > hi) continue;
    for (const x of [lo, hi]) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      const y = b.x === a.x ? Math.min(a.y, b.y) : a.y + t * (b.y - a.y);
      const y2 = b.x === a.x ? Math.max(a.y, b.y) : y;
      min = Math.min(min, y, y2);
      max = Math.max(max, y, y2);
    }
  }
  if (min === Infinity) {
    let best = curve[0]!;
    const middle = (x0 + x1) / 2;
    for (const point of curve) if (Math.abs(point.x - middle) < Math.abs(best.x - middle)) best = point;
    return { min: best.y, max: best.y };
  }
  return { min, max };
}

function pointBoxDistance(point: Point, box: FormatLayoutBox): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** The shortest distance between a polyline and a box (0 when it enters the box). */
function polylineBoxDistance(curve: readonly Point[], box: FormatLayoutBox): number {
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x, y: box.y + box.height },
    { x: box.x + box.width, y: box.y + box.height },
  ];
  let best = Infinity;
  for (let i = 0; i + 1 < curve.length; i += 1) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    if (segmentHitsBox(a, b, box)) return 0;
    best = Math.min(best, pointBoxDistance(a, box), pointBoxDistance(b, box));
    for (const corner of corners) best = Math.min(best, pointSegmentDistance(corner, a, b));
  }
  return best;
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return value > 1e-9 ? 1 : value < -1e-9 ? -1 : 0;
}

/** Whether two segments cross at a point inside both (touching or collinear runs do not count). */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/** Whether the segment enters the box (Liang-Barsky clipping). */
function segmentHitsBox(a: Point, b: Point, box: FormatLayoutBox): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: Array<[number, number]> = [
    [-dx, a.x - box.x],
    [dx, box.x + box.width - a.x],
    [-dy, a.y - box.y],
    [dy, box.y + box.height - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}
