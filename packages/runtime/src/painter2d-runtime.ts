import { PAINTER_MAX_COMMANDS, PAINTER_MAX_MASK_DEPTH, PAINTER_MAX_PATH_SEGMENTS, PAINTER_MAX_TOTAL_SEGMENTS, painterPoint, parsePainter2DProperties,
  type Painter2DProperties, type PainterCommand, type PainterPathSegment, type PainterPoint } from "@babylonslate/core";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
import { componentOwners } from "./world-component-index";

/** `revision` names the current command stream; `sentRevision` is the one the last flush sent to the renderer. */
type State = { commands: PainterCommand[]; path: PainterPathSegment[]; maskDepth: number; segments: number; revision: number; sentRevision?: number };

/** One clock for every painter, so a revision never repeats across painters, components or runtimes in this realm. */
let revisionClock = 0;
/** Marks a command change: any payload stamped with an earlier revision is now stale. */
function touch(state: State): void { state.revision = ++revisionClock; }

/** Retained drawing belongs to the live component, never a debug overlay or a global canvas. */
export class Painter2DRuntime {
  private readonly states = new WeakMap<ActorComponent, State>();
  private readonly dirty = new Set<ActorComponent>();
  /** Painters that may hold drawing for a frame start to clear; while empty, frames skip the actor walk. */
  private readonly drawn = new Set<ActorComponent>();

  payload(component: ActorComponent): Painter2DProperties {
    const properties = parsePainter2DProperties(Object.fromEntries(component.variables));
    let state = this.states.get(component);
    if (!state) {
      state = { commands: properties.commands, path: [], maskDepth: properties.commands.reduce((depth, command) => depth + (command.kind === "pushMask" ? 1 : command.kind === "popMask" ? -1 : 0), 0), segments: properties.commands.reduce((count, command) => count + (command.kind === "popMask" ? 0 : command.path.length), 0), revision: ++revisionClock };
      this.states.set(component, state);
      if (state.commands.length) this.drawn.add(component);
    }
    return { ...properties, commands: structuredClone(state.commands), revision: state.revision };
  }

  execute(component: ActorComponent, name: string, args: Record<string, unknown>): boolean {
    if (component.classId !== "2DPainterComponent" || component.destroyed || !component.owner?.sceneLayerId || component.owner.destroyed) return false;
    if (!this.states.has(component)) this.payload(component);
    this.drawn.add(component);
    const properties = parsePainter2DProperties({ ...Object.fromEntries(component.variables), commands: [] });
    const state = this.states.get(component)!;
    if (name === "painterClear") {
      if (state.commands.length) touch(state);
      state.commands = []; state.path = []; state.maskDepth = 0; state.segments = 0; this.dirty.add(component); return true;
    }
    if (name === "painterBeginPath") { state.path = []; return true; }
    if (name === "painterPopMask") {
      if (!state.maskDepth || state.commands.length >= PAINTER_MAX_COMMANDS) return false;
      state.maskDepth--; state.commands.push({ kind: "popMask" }); touch(state); this.dirty.add(component); return true;
    }
    const point = (key: string) => painterPoint(args[key]);
    const scalar = (key: string, fallback = 0): number | null => !Object.hasOwn(args, key) ? fallback
      : typeof args[key] === "number" && Number.isFinite(args[key]) ? args[key] as number : null;
    let segment: PainterPathSegment | null = null;
    if (name === "painterMoveTo" || name === "painterLineTo") {
      const p = point("point"); if (!p) return false;
      segment = { kind: name === "painterMoveTo" ? "move" : "line", point: p };
    } else if (name === "painterQuadraticTo") {
      const p = point("point"), control = point("control"); if (!p || !control) return false;
      segment = { kind: "quadratic", point: p, control };
    } else if (name === "painterBezierTo") {
      const p = point("point"), control1 = point("control1"), control2 = point("control2"); if (!p || !control1 || !control2) return false;
      segment = { kind: "bezier", point: p, control1, control2 };
    } else if (name === "painterClosePath") segment = { kind: "close" };
    else if (name === "painterArc") {
      const center = point("center"), radius = point("radius"); if (!center || !radius || radius.some((r) => r < 0)) return false;
      const rotation = scalar("rotation"), start = scalar("startAngle"), end = scalar("endAngle", Math.PI * 2);
      if (rotation === null || start === null || end === null || Object.hasOwn(args, "anticlockwise") && typeof args.anticlockwise !== "boolean") return false;
      segment = { kind: "ellipse", center, radius, rotation, start, end, anticlockwise: args.anticlockwise === true };
    }
    if (segment) {
      if (state.path.length >= PAINTER_MAX_PATH_SEGMENTS) return false;
      state.path.push(segment); return true;
    }
    let path: PainterPathSegment[];
    let fill = properties.fill, stroke = properties.stroke;
    if (["painterFillPath", "painterStrokePath", "painterPushMask", "painterCutOutPath"].includes(name)) {
      path = structuredClone(state.path);
      if (name === "painterFillPath") { fill = true; stroke = false; }
      if (name === "painterStrokePath") { fill = false; stroke = true; }
    } else if (name === "painterDrawLine") {
      const start = point("start"), end = point("end"); if (!start || !end) return false;
      path = [{ kind: "move", point: start }, { kind: "line", point: end }]; fill = false; stroke = true;
    } else if (name === "painterDrawPolyline" || name === "painterDrawPolygon") {
      if (!Array.isArray(args.points) || args.points.length > PAINTER_MAX_PATH_SEGMENTS - 1) return false;
      const points = args.points.map(painterPoint);
      if (points.length < (name === "painterDrawPolygon" ? 3 : 2) || points.some((p) => !p)) return false;
      path = points.map((p, i) => ({ kind: i ? "line" : "move", point: p! }));
      if (name === "painterDrawPolygon") path.push({ kind: "close" }); else { fill = false; stroke = true; }
    } else if (name === "painterDrawRectangle") {
      const center = point("center"), size = point("size"); if (!center || !size || size.some((v) => v < 0)) return false;
      const [x, y] = center, [w, h] = size;
      path = ([[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]] as PainterPoint[]).map((p, i) => ({ kind: i ? "line" : "move", point: p }));
      if (path.some((segment) => (segment.kind === "move" || segment.kind === "line") && !painterPoint(segment.point))) return false;
      path.push({ kind: "close" });
    } else if (name === "painterDrawCircle" || name === "painterDrawEllipse") {
      const center = point("center");
      const circleRadius = name === "painterDrawCircle" ? scalar("radius") : null;
      const radius = name === "painterDrawCircle" ? circleRadius === null ? null : [circleRadius, circleRadius] as PainterPoint : point("radius");
      if (!center || !radius || radius.some((r) => r < 0)) return false;
      path = [{ kind: "ellipse", center, radius, rotation: 0, start: 0, end: Math.PI * 2, anticlockwise: false }, { kind: "close" }];
    } else return false;
    if (!path.length || state.commands.length >= PAINTER_MAX_COMMANDS || state.segments + path.length > PAINTER_MAX_TOTAL_SEGMENTS) return false;
    const fillRule = properties.fillRule;
    if (name === "painterPushMask") {
      if (state.maskDepth >= PAINTER_MAX_MASK_DEPTH) return false;
      state.maskDepth++; state.commands.push({ kind: "pushMask", path, fillRule });
    } else if (name === "painterCutOutPath") state.commands.push({ kind: "cutout", path, fillRule });
    else state.commands.push({ kind: "draw", path, fill, stroke, fillRule, style: { fillColor: properties.fillColor, strokeColor: properties.strokeColor, strokeWidth: properties.strokeWidth, lineCap: properties.lineCap, lineJoin: properties.lineJoin } });
    state.segments += path.length;
    touch(state);
    this.dirty.add(component);
    return true;
  }

  beginFrame(world: World, canTick: (actor: Actor) => boolean): void {
    if (this.drawn.size === 0) return;
    for (const component of this.drawn) {
      if (component.destroyed || !component.owner || component.owner.destroyed) this.drawn.delete(component);
    }
    for (const actor of componentOwners(world, "2DPainterComponent")) {
      if (!actor.sceneLayerId || actor.destroyed || !canTick(actor)) continue;
      for (const component of actor.components) {
        if (component.classId !== "2DPainterComponent" || component.destroyed || component.getVariable("clearEachFrame") === false) continue;
        const state = this.states.get(component);
        this.drawn.delete(component);
        if (!state || (!state.commands.length && !state.path.length)) continue;
        if (state.commands.length) touch(state);
        state.commands = []; state.path = []; state.maskDepth = 0; state.segments = 0; this.dirty.add(component);
      }
    }
  }

  flush(send: (component: ActorComponent, painter: Painter2DProperties) => void): void {
    for (const component of this.dirty) {
      if (component.destroyed || !component.owner || component.owner.destroyed) continue;
      // The last flush already sent this stream (the edits changed no command): nothing to clone or send.
      const state = this.states.get(component);
      if (!state || state.revision === state.sentRevision) continue;
      state.sentRevision = state.revision;
      send(component, this.payload(component));
    }
    this.dirty.clear();
  }
}
