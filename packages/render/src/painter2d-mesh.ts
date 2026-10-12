import { Color3, CreatePlaneVertexData, DynamicTexture, MeshBuilder, StandardMaterial, Texture, type Mesh, type Scene } from "@babylonjs/core";
import { painterTextureSize, parsePainter2DProperties, type Painter2DProperties, type PainterColor, type PainterCommand, type PainterPathSegment } from "@babylonslate/core";
import { applyOverlayVisualStyle } from "./overlay-visual-style";

type PaintContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
function rgba([r, g, b, a]: PainterColor): string { return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`; }

function tracePath(context: PaintContext, path: readonly PainterPathSegment[]): void {
  context.beginPath();
  for (const segment of path) {
    switch (segment.kind) {
      case "move": context.moveTo(...segment.point); break;
      case "line": context.lineTo(...segment.point); break;
      case "quadratic": context.quadraticCurveTo(...segment.control, ...segment.point); break;
      case "bezier": context.bezierCurveTo(...segment.control1, ...segment.control2, ...segment.point); break;
      case "ellipse": context.ellipse(...segment.center, ...segment.radius, segment.rotation, segment.start, segment.end, segment.anticlockwise); break;
      case "close": context.closePath(); break;
    }
  }
}

/** Replays a complete component stream. Clip state never escapes this painter or replay. */
export function paint2DCommands(context: PaintContext, commands: readonly PainterCommand[], width: number, height: number, worldWidth: number, worldHeight: number): void {
  context.save();
  let maskDepth = 0;
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.setTransform(width / worldWidth, 0, 0, -height / worldHeight, width / 2, height / 2);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    for (const command of commands) {
      if (command.kind === "popMask") { if (maskDepth > 0) { context.restore(); maskDepth--; } continue; }
      tracePath(context, command.path);
      if (command.kind === "pushMask") { context.save(); context.clip(command.fillRule); maskDepth++; continue; }
      if (command.kind === "cutout") {
        context.save(); context.globalCompositeOperation = "destination-out"; context.fillStyle = "#fff"; context.fill(command.fillRule); context.restore(); continue;
      }
      context.fillStyle = rgba(command.style.fillColor);
      context.strokeStyle = rgba(command.style.strokeColor);
      context.lineWidth = command.style.strokeWidth;
      context.lineCap = command.style.lineCap;
      context.lineJoin = command.style.lineJoin;
      if (command.fill) context.fill(command.fillRule);
      if (command.stroke && command.style.strokeWidth > 0) context.stroke();
    }
  } finally {
    while (maskDepth-- > 0) context.restore();
    context.restore();
  }
}

type PainterVisual = {
  texture: DynamicTexture;
  properties: Painter2DProperties;
  /** Inputs of the replay the canvas and its upload currently reflect; unset until one completes. */
  painted?: { commands: readonly PainterCommand[]; width: number; height: number; textureWidth: number; textureHeight: number };
};
const visuals = new WeakMap<Mesh, PainterVisual>();

/** Equality of parsed command data (numbers, strings, booleans, arrays and plain objects). */
function samePainterData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => samePainterData(value, b[index]));
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && samePainterData(left[key], right[key]));
}

function textureSizeFor(scene: Scene, properties: Painter2DProperties): { width: number; height: number } {
  return painterTextureSize(properties.width, properties.height, properties.pixelsPerUnit, Math.min(4096, scene.getEngine().getCaps().maxTextureSize || 4096));
}

export function createPainter2DMesh(scene: Scene, name: string, value: unknown): Mesh {
  const properties = parsePainter2DProperties(value);
  const mesh = MeshBuilder.CreatePlane(name, { width: properties.width, height: properties.height }, scene);
  const material = new StandardMaterial(`${name}-painter`, scene);
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.White();
  material.backFaceCulling = false;
  material.useAlphaFromDiffuseTexture = true;
  material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
  mesh.material = material;
  mesh.metadata = { ...(mesh.metadata ?? {}), painter2d: true };
  let texture: DynamicTexture | undefined;
  mesh.onDisposeObservable.addOnce(() => { visuals.delete(mesh); material.dispose(); texture?.dispose(); });
  try {
    texture = new DynamicTexture(`${name}-painter-canvas`, textureSizeFor(scene, properties), scene, false, Texture.BILINEAR_SAMPLINGMODE);
    texture.hasAlpha = true;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    material.diffuseTexture = texture;
    visuals.set(mesh, { texture, properties });
    updatePainter2DMesh(mesh, properties);
    applyOverlayVisualStyle(mesh, value);
    return mesh;
  } catch (error) { mesh.dispose(); throw error; }
}

/**
 * Drawing updates retain the plane, material and texture rather than rebuilding
 * the actor. A new world size reshapes the plane, and a new texel size resizes
 * the canvas texture, before the stream is replayed. A stream the canvas already
 * shows at the same sizes is neither replayed nor uploaded again.
 */
export function updatePainter2DMesh(mesh: Mesh, value: unknown): boolean {
  const visual = visuals.get(mesh);
  if (!visual || mesh.isDisposed()) return false;
  const properties = parsePainter2DProperties(value);
  if (properties.width !== visual.properties.width || properties.height !== visual.properties.height) {
    CreatePlaneVertexData({ width: properties.width, height: properties.height }).applyToMesh(mesh);
  }
  const wanted = textureSizeFor(mesh.getScene(), properties);
  const current = visual.texture.getSize();
  if (wanted.width !== current.width || wanted.height !== current.height) visual.texture.scaleTo(wanted.width, wanted.height);
  const size = visual.texture.getSize();
  const painted = visual.painted;
  if (painted && painted.width === properties.width && painted.height === properties.height &&
    painted.textureWidth === size.width && painted.textureHeight === size.height &&
    samePainterData(painted.commands, properties.commands)) {
    visual.properties = properties;
    return true;
  }
  // A replay that throws leaves the canvas partly drawn, so nothing counts as shown until the upload completes.
  visual.painted = undefined;
  paint2DCommands(visual.texture.getContext() as PaintContext, properties.commands, size.width, size.height, properties.width, properties.height);
  visual.properties = properties;
  visual.texture.update();
  visual.painted = { commands: properties.commands, width: properties.width, height: properties.height, textureWidth: size.width, textureHeight: size.height };
  return true;
}
