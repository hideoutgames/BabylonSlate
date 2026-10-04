import { Color3, DynamicTexture, MeshBuilder, StandardMaterial, Texture, type Mesh, type Scene } from "@babylonjs/core";
import { painterTextureSize, parsePainter2DProperties, type Painter2DProperties, type PainterColor, type PainterCommand, type PainterPathSegment } from "@babylonslate/core";

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

type PainterVisual = { texture: DynamicTexture; properties: Painter2DProperties };
const visuals = new WeakMap<Mesh, PainterVisual>();

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
    const size = painterTextureSize(properties.width, properties.height, properties.pixelsPerUnit, Math.min(4096, scene.getEngine().getCaps().maxTextureSize || 4096));
    texture = new DynamicTexture(`${name}-painter-canvas`, size, scene, false, Texture.BILINEAR_SAMPLINGMODE);
    texture.hasAlpha = true;
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    material.diffuseTexture = texture;
    visuals.set(mesh, { texture, properties });
    updatePainter2DMesh(mesh, properties);
    return mesh;
  } catch (error) { mesh.dispose(); throw error; }
}

/** Drawing updates retain the plane, material and texture rather than rebuilding the actor. */
export function updatePainter2DMesh(mesh: Mesh, value: unknown): boolean {
  const visual = visuals.get(mesh);
  if (!visual || mesh.isDisposed()) return false;
  const properties = parsePainter2DProperties(value);
  const size = visual.texture.getSize();
  paint2DCommands(visual.texture.getContext() as PaintContext, properties.commands, size.width, size.height, properties.width, properties.height);
  visual.properties = properties;
  visual.texture.update();
  return true;
}
