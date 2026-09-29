import { parseSceneLayerHitTest, type SceneLayerHitTest } from "./scene-layer";

export type PainterPoint = [number, number];
export type PainterColor = [number, number, number, number];
export type PainterFillRule = "nonzero" | "evenodd";
export type PainterPathSegment =
  | { kind: "move" | "line"; point: PainterPoint }
  | { kind: "quadratic"; control: PainterPoint; point: PainterPoint }
  | { kind: "bezier"; control1: PainterPoint; control2: PainterPoint; point: PainterPoint }
  | { kind: "ellipse"; center: PainterPoint; radius: PainterPoint; rotation: number; start: number; end: number; anticlockwise: boolean }
  | { kind: "close" };
export type PainterStyle = { fillColor: PainterColor; strokeColor: PainterColor; strokeWidth: number; lineCap: "butt" | "round" | "square"; lineJoin: "miter" | "round" | "bevel" };
export type PainterCommand =
  | { kind: "draw"; path: PainterPathSegment[]; fill: boolean; stroke: boolean; fillRule: PainterFillRule; style: PainterStyle }
  | { kind: "pushMask" | "cutout"; path: PainterPathSegment[]; fillRule: PainterFillRule }
  | { kind: "popMask" };
export type Painter2DProperties = PainterStyle & {
  width: number; height: number; pixelsPerUnit: number; clearEachFrame: boolean;
  fill: boolean; stroke: boolean; fillRule: PainterFillRule; hitTest: SceneLayerHitTest;
  commands: PainterCommand[];
};

export const PAINTER_MAX_COMMANDS = 16_384;
export const PAINTER_MAX_PATH_SEGMENTS = 8_192;
export const PAINTER_MAX_TOTAL_SEGMENTS = 65_536;
export const PAINTER_MAX_MASK_DEPTH = 32;

function finite(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
export function painterPoint(value: unknown): PainterPoint | null {
  const p = value as { x?: unknown; y?: unknown } | null;
  const x = Array.isArray(value) ? value[0] : p?.x;
  const y = Array.isArray(value) ? value[1] : p?.y;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? [x, y] : null;
}
function color(value: unknown): PainterColor {
  const source = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown } | null;
  const values = Array.isArray(value) ? value : [source?.x, source?.y, source?.z, source?.w];
  return [0, 1, 2, 3].map((i) => Math.max(0, Math.min(1, finite(values[i], 1)))) as PainterColor;
}
export function parsePainterStyle(value: unknown): PainterStyle {
  const p = (value ?? {}) as Record<string, unknown>;
  return { fillColor: color(p.fillColor), strokeColor: color(p.strokeColor), strokeWidth: Math.max(0, finite(p.strokeWidth, 0.02)),
    lineCap: p.lineCap === "round" || p.lineCap === "square" ? p.lineCap : "butt",
    lineJoin: p.lineJoin === "round" || p.lineJoin === "bevel" ? p.lineJoin : "miter" };
}
export function parsePainterPath(value: unknown): PainterPathSegment[] {
  if (!Array.isArray(value) || value.length > PAINTER_MAX_PATH_SEGMENTS) return [];
  const path: PainterPathSegment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return [];
    const s = raw as Record<string, unknown>;
    const point = painterPoint(s.point);
    if ((s.kind === "move" || s.kind === "line") && point) path.push({ kind: s.kind, point });
    else if (s.kind === "quadratic" && point && painterPoint(s.control)) path.push({ kind: s.kind, point, control: painterPoint(s.control)! });
    else if (s.kind === "bezier" && point && painterPoint(s.control1) && painterPoint(s.control2)) path.push({ kind: s.kind, point, control1: painterPoint(s.control1)!, control2: painterPoint(s.control2)! });
    else if (s.kind === "ellipse" && painterPoint(s.center) && painterPoint(s.radius)) {
      const radius = painterPoint(s.radius)!;
      if (radius[0] < 0 || radius[1] < 0) return [];
      path.push({ kind: "ellipse", center: painterPoint(s.center)!, radius, rotation: finite(s.rotation), start: finite(s.start), end: finite(s.end, Math.PI * 2), anticlockwise: s.anticlockwise === true });
    } else if (s.kind === "close") path.push({ kind: "close" });
    else return [];
  }
  return path;
}
export function parsePainterCommands(value: unknown): PainterCommand[] {
  if (!Array.isArray(value) || value.length > PAINTER_MAX_COMMANDS) return [];
  const commands: PainterCommand[] = [];
  let depth = 0;
  let segments = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (c.kind === "popMask") { if (depth > 0) { depth--; commands.push({ kind: "popMask" }); } continue; }
    const path = parsePainterPath(c.path);
    if (!path.length) continue;
    if (segments + path.length > PAINTER_MAX_TOTAL_SEGMENTS) break;
    segments += path.length;
    const fillRule = c.fillRule === "evenodd" ? "evenodd" : "nonzero";
    if (c.kind === "pushMask") { if (depth < PAINTER_MAX_MASK_DEPTH) { depth++; commands.push({ kind: c.kind, path, fillRule }); } }
    else if (c.kind === "cutout") commands.push({ kind: c.kind, path, fillRule });
    else if (c.kind === "draw") commands.push({ kind: c.kind, path, fill: c.fill === true, stroke: c.stroke === true, fillRule, style: parsePainterStyle(c.style) });
  }
  return commands;
}
export function parsePainter2DProperties(value: unknown): Painter2DProperties {
  const p = (value ?? {}) as Record<string, unknown>;
  return { ...parsePainterStyle(p), width: Math.max(0.001, Math.min(1_000_000, finite(p.width, 10))), height: Math.max(0.001, Math.min(1_000_000, finite(p.height, 10))),
    pixelsPerUnit: Math.max(1, Math.min(1024, finite(p.pixelsPerUnit, 100))), clearEachFrame: p.clearEachFrame !== false,
    fill: p.fill !== false, stroke: p.stroke !== false, fillRule: p.fillRule === "evenodd" ? "evenodd" : "nonzero",
    hitTest: parseSceneLayerHitTest(p.hitTest), commands: parsePainterCommands(p.commands) };
}

/** Keep one painter's canvas/GPU working set bounded, preserving its aspect ratio. */
export function painterTextureSize(width: number, height: number, pixelsPerUnit: number, maxTextureSize = 4096): { width: number; height: number } {
  const w = Math.max(1, width * pixelsPerUnit), h = Math.max(1, height * pixelsPerUnit);
  const scale = Math.min(1, maxTextureSize / w, maxTextureSize / h, Math.sqrt(4_194_304 / (w * h)));
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}
