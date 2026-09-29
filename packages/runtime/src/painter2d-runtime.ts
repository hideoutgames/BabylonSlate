import { PAINTER_MAX_COMMANDS, PAINTER_MAX_MASK_DEPTH, PAINTER_MAX_PATH_SEGMENTS, PAINTER_MAX_TOTAL_SEGMENTS, painterPoint, parsePainter2DProperties,
  type Painter2DProperties, type PainterCommand, type PainterPathSegment, type PainterPoint } from "@babylonslate/core";
import type { Actor, ActorComponent } from "@babylonslate/object-model";

type State = { commands: PainterCommand[]; path: PainterPathSegment[]; maskDepth: number; segments: number };

/** Retained drawing belongs to the live component, never a debug overlay or a global canvas. */
export class Painter2DRuntime {
  private readonly states = new WeakMap<ActorComponent, State>();
  private readonly dirty = new Set<ActorComponent>();

  payload(component: ActorComponent): Painter2DProperties {
    const properties = parsePainter2DProperties(Object.fromEntries(component.variables));
    let state = this.states.get(component);
    if (!state) {
      state = { commands: properties.commands, path: [], maskDepth: properties.commands.reduce((depth, command) => depth + (command.kind === "pushMask" ? 1 : command.kind === "popMask" ? -1 : 0), 0), segments: properties.commands.reduce((count, command) => count + (command.kind === "popMask" ? 0 : command.path.length), 0) };
      this.states.set(component, state);
    }
    return { ...properties, commands: structuredClone(state.commands) };
  }

  execute(component: ActorComponent, name: string, args: Record<string, unknown>): boolean {
    if (component.classId !== "2DPainterComponent" || component.destroyed || !component.owner?.sceneLayerId || component.owner.destroyed) return false;
    if (!this.states.has(component)) this.payload(component);
    const properties = parsePainter2DProperties({ ...Object.fromEntries(component.variables), commands: [] });
    const state = this.states.get(component)!;
    if (name === "painterClear") {
      state.commands = []; state.path = []; state.maskDepth = 0; state.segments = 0; this.dirty.add(component); return true;
    }
    if (name === "painterBeginPath") { state.path = []; return true; }
    if (name === "painterPopMask") {
      if (!state.maskDepth || state.commands.length >= PAINTER_MAX_COMMANDS) return false;
      state.maskDepth--; state.commands.push({ kind: "popMask" }); this.dirty.add(component); return true;
    }
    const point = (key: string) => painterPoint(args[key]);
    const scalar = (key: string, fallback = 0) => typeof args[key] === "number" && Number.isFinite(args[key]) ? args[key] as number : fallback;
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
      segment = { kind: "ellipse", center, radius, rotation: scalar("rotation"), start: scalar("startAngle"), end: scalar("endAngle", Math.PI * 2), anticlockwise: args.anticlockwise === true };
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
      path.push({ kind: "close" });
    } else if (name === "painterDrawCircle" || name === "painterDrawEllipse") {
      const center = point("center");
      const radius = name === "painterDrawCircle" ? [scalar("radius"), scalar("radius")] as PainterPoint : point("radius");
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
    this.dirty.add(component);
    return true;
  }

  beginFrame(actors: readonly Actor[], canTick: (actor: Actor) => boolean): void {
    for (const actor of actors) {
      if (!actor.sceneLayerId || actor.destroyed || !canTick(actor)) continue;
      for (const component of actor.components) {
        if (component.classId !== "2DPainterComponent" || component.destroyed || component.getVariable("clearEachFrame") === false) continue;
        const state = this.states.get(component);
        if (!state || (!state.commands.length && !state.path.length)) continue;
        state.commands = []; state.path = []; state.maskDepth = 0; state.segments = 0; this.dirty.add(component);
      }
    }
  }

  flush(send: (component: ActorComponent, painter: Painter2DProperties) => void): void {
    for (const component of this.dirty) if (!component.destroyed && component.owner && !component.owner.destroyed) send(component, this.payload(component));
    this.dirty.clear();
  }
}
