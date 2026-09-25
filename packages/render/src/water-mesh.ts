import { Matrix, Mesh, PBRMaterial, Vector3, VertexBuffer, VertexData, type Material, type Scene } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, sampleWaterWaves, waterFootprint, type WaterBodyProperties, type WaterDefinition } from "@babylonslate/core";
import { configureWaterMaterial, WaterMaterialPlugin } from "./water-material";

type Surface = {
  mesh: Mesh; water: WaterDefinition; body: WaterBodyProperties; plugin: WaterMaterialPlugin | null;
  layout: string; base: Float32Array; positions: Float32Array; normals: Float32Array;
  baseNormals: Float32Array; data: Float32Array; flow: Float32Array; spacing: Float32Array;
};
const surfaces = new WeakMap<Scene, Set<Surface>>();
const clocks = new WeakMap<Scene, { time: number; runtime: boolean }>();

export function sceneHasWater(scene: Scene): boolean { return (surfaces.get(scene)?.size ?? 0) > 0; }
export function setSceneWaterTime(scene: Scene, seconds: number): void {
  if (Number.isFinite(seconds)) clocks.set(scene, { time: seconds, runtime: true });
}

/** Called once per scene render; runtime water advances only with the worker clock. */
export function updateSceneWater(scene: Scene): void {
  const clock = clocks.get(scene) ?? { time: 0, runtime: false };
  if (!clock.runtime) clock.time += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000 || 0);
  clocks.set(scene, clock);
  for (const surface of surfaces.get(scene) ?? []) if (surface.mesh.isEnabled()) updateSurface(surface, clock.time);
}

/** Fixed endpoints, dense world-sized cells near the camera, smoothly graded outer cells. */
function axis(min: number, max: number, spacing: number, camera: number, budget = 192): number[] {
  const count = Math.min(budget, Math.max(8, Math.ceil((max - min) / spacing / 2) * 2));
  if ((max - min) <= count * spacing) return Array.from({ length: count + 1 }, (_, i) => min + (max - min) * i / count);
  const outer = Math.floor(count / 4), inner = count - 2 * outer;
  const half = inner * spacing / 2;
  const center = Math.max(min + half, Math.min(max - half, Math.round(camera / spacing) * spacing));
  const left = center - half, right = center + half;
  return Array.from({ length: count + 1 }, (_, i) => {
    if (i < outer) return left - (left - min) * Math.pow((outer - i) / outer, 3);
    if (i > count - outer) return right + (max - right) * Math.pow((i - count + outer) / outer, 3);
    return left + (i - outer) * spacing;
  });
}

function riverPoint(body: WaterBodyProperties, along: number, across: number): [number, number] {
  const distances = body.points.slice(1).map((p, i) => Math.hypot(p[0] - body.points[i]![0], p[2] - body.points[i]![2]));
  const total = distances.reduce((a, b) => a + b, 0);
  const distance = along * (total + body.width) - body.width / 2;
  let remaining = Math.max(0, Math.min(total, distance)), segment = 0;
  while (segment < distances.length - 1 && remaining > distances[segment]!) remaining -= distances[segment++]!;
  const a = body.points[segment]!, b = body.points[segment + 1]!;
  const length = Math.max(1e-6, distances[segment]!);
  const dx = (b[0] - a[0]) / length, dz = (b[2] - a[2]) / length, t = remaining / length;
  const outside = distance < 0 ? distance : distance > total ? distance - total : 0;
  const radius = body.width / 2, halfWidth = Math.sqrt(Math.max(0, radius * radius - outside * outside));
  return [a[0] + (b[0] - a[0]) * t + dx * outside - dz * across * halfWidth, a[2] + (b[2] - a[2]) * t + dz * outside + dx * across * halfWidth];
}

function updateLayout(s: Surface, world: Matrix, inverse: Matrix): void {
  const { body, water, mesh } = s;
  const m = world.m;
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const camera = mesh.getScene().activeCamera;
  // Read the camera's current position, including a parent, without waiting for Scene.render's camera update.
  const cameraWorld = camera ? (camera.parent ? Vector3.TransformCoordinates(camera.position, camera.parent.getWorldMatrix()) : camera.position) : Vector3.Zero();
  const local = Vector3.TransformCoordinates(cameraWorld, inverse);
  const step = Math.max(0.025, water.waveLength / 12 * 48 / body.resolution);
  let xs: number[], zs: number[];
  if (body.kind === "global") {
    const extent = Math.max(256, (camera?.maxZ ?? 1000) * 1.2);
    const cx = Math.round(local.x * sx / step) * step / sx, cz = Math.round(local.z * sz / step) * step / sz;
    const budget = Math.max(32, body.resolution + body.resolution % 2);
    xs = axis(cx - extent / sx, cx + extent / sx, step / sx, cx, budget);
    zs = axis(cz - extent / sz, cz + extent / sz, step / sz, cz, budget);
  } else if (body.kind === "river") {
    const length = body.points.slice(1).reduce((sum, p, i) => {
      const a = body.points[i]!;
      return sum + Math.hypot((p[0] - a[0]) * sx, (p[2] - a[2]) * sz);
    }, body.width * Math.max(sx, sz));
    const columns = Math.min(96, Math.max(8, Math.ceil(body.width * Math.max(sx, sz) / step / 2) * 2));
    const rows = Math.min(384, Math.max(8, Math.ceil(length / step / 2) * 2));
    xs = Array.from({ length: columns + 1 }, (_, i) => i / columns * 2 - 1);
    zs = Array.from({ length: rows + 1 }, (_, i) => i / rows);
  } else {
    xs = axis(-body.width / 2, body.width / 2, step / sx, local.x);
    zs = axis(-body.length / 2, body.length / 2, step / sz, local.z);
  }
  const layout = Array.from(world.m).slice(0, 12).join(",") + ":" + xs.join(",") + ":" + zs.join(",");
  if (layout === s.layout) return;
  s.layout = layout;
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  const columns = xs.length - 1, rows = zs.length - 1;
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    let x = xs[col]!, z = zs[row]!;
    if (body.kind === "river") [x, z] = riverPoint(body, z, x);
    else if (body.kind === "lake" || body.kind === "puddle") {
      const u = x * 2 / body.width, v = z * 2 / body.length;
      x *= Math.sqrt(1 - v * v / 2); z *= Math.sqrt(1 - u * u / 2);
    }
    positions.push(x, waterFootprint(body, x, z).height, z);
    uvs.push(col / columns, row / rows);
    if (row < rows && col < columns) {
      const a = row * (columns + 1) + col, b = a + columns + 1;
      if (body.kind === "river") indices.push(a, b, a + 1, a + 1, b, b + 1);
      else indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  s.base = new Float32Array(positions); s.positions = new Float32Array(positions);
  s.normals = new Float32Array(positions.length); s.baseNormals = new Float32Array(positions.length);
  s.data = new Float32Array(positions.length / 3 * 4); s.flow = new Float32Array(positions.length);
  s.spacing = new Float32Array(positions.length / 3);
  const a = new Vector3(), b = new Vector3();
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const index = row * (columns + 1) + col;
    Vector3.TransformCoordinatesToRef(Vector3.FromArray(positions, index * 3), world, a);
    let spacing = 0;
    for (const neighbor of [col > 0 ? index - 1 : index + 1, col < columns ? index + 1 : index - 1, row > 0 ? index - columns - 1 : index + columns + 1, row < rows ? index + columns + 1 : index - columns - 1]) {
      Vector3.TransformCoordinatesToRef(Vector3.FromArray(positions, neighbor * 3), world, b);
      spacing = Math.max(spacing, Math.hypot(a.x - b.x, a.z - b.z));
    }
    s.spacing[index] = spacing;
  }
  const data = new VertexData();
  data.positions = s.positions; data.normals = s.normals; data.indices = indices; data.uvs = uvs;
  data.applyToMesh(mesh, true);
  mesh.setVerticesData("slateWaterData", s.data, true, 4);
  mesh.setVerticesData("slateWaterFlow", s.flow, true, 3);
  mesh.setVerticesData("slateWaterBaseNormal", s.baseNormals, true, 3);
}

function updateSurface(s: Surface, time: number): void {
  const world = s.mesh.computeWorldMatrix(true);
  if (Math.abs(world.determinant()) < 1e-12) return;
  const inverse = world.clone().invert(), normalMatrix = Matrix.Transpose(inverse), toLocalNormal = Matrix.Transpose(world);
  updateLayout(s, world, inverse);
  const up = Vector3.TransformNormal(Vector3.Up(), inverse);
  const depth = s.body.depth * Vector3.TransformNormal(Vector3.Up(), world).length();
  const point = new Vector3(), baseNormal = new Vector3(), localNormal = new Vector3(), flow = new Vector3(), edge = new Vector3();
  for (let i = 0; i < s.base.length; i += 3) {
    const x = s.base[i]!, y = s.base[i + 1]!, z = s.base[i + 2]!;
    point.set(x, y, z); Vector3.TransformCoordinatesToRef(point, world, point);
    const footprint = waterFootprint(s.body, x, z);
    const wave = sampleWaterWaves(s.water, point.x, point.z, time, s.body.waveScale, s.spacing[i / 3]);
    s.positions[i] = x + up.x * wave.height; s.positions[i + 1] = y + up.y * wave.height; s.positions[i + 2] = z + up.z * wave.height;
    baseNormal.set(-footprint.slopeX, 1, -footprint.slopeZ);
    Vector3.TransformNormalToRef(baseNormal, normalMatrix, baseNormal);
    baseNormal.scaleInPlace(baseNormal.y < 0 ? -1 : 1).normalize();
    baseNormal.toArray(s.baseNormals, i);
    const ny = Math.max(1e-6, baseNormal.y);
    localNormal.set(baseNormal.x / ny + wave.normal.x / wave.normal.y, 1, baseNormal.z / ny + wave.normal.z / wave.normal.y);
    Vector3.TransformNormalToRef(localNormal, toLocalNormal, localNormal); localNormal.normalize().toArray(s.normals, i);
    edge.set(footprint.edgeX, 0, footprint.edgeZ); Vector3.TransformNormalToRef(edge, normalMatrix, edge);
    flow.set(footprint.flowX, footprint.flowY, footprint.flowZ); Vector3.TransformNormalToRef(flow, world, flow);
    flow.scaleInPlace(s.body.flowSpeed / Math.max(1e-6, Math.hypot(flow.x, flow.z))).toArray(s.flow, i);
    const d = i / 3 * 4;
    s.data[d] = wave.height; s.data[d + 1] = Math.min(10000, Math.max(0, footprint.edge / (edge.length() || 1)));
    s.data[d + 2] = depth; s.data[d + 3] = time;
  }
  s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, true);
  s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals);
  s.mesh.updateVerticesData("slateWaterData", s.data);
  s.mesh.updateVerticesData("slateWaterFlow", s.flow);
  s.mesh.updateVerticesData("slateWaterBaseNormal", s.baseNormals);
  if (s.plugin) s.plugin.time = time;
}

/** Finite volumes keep fixed bounds; only Global Water Volume follows the camera. */
export function createWaterMesh(scene: Scene, name: string, input: WaterBodyProperties, definition?: WaterDefinition, customMaterial?: Material | null): Mesh {
  const body = normalizeWaterBody(input, input.kind), water = normalizeWaterDefinition(definition ?? createDefaultWaterDefinition());
  const mesh = new Mesh(name, scene);
  mesh.setEnabled(body.enabled);
  mesh.metadata = { ...(mesh.metadata ?? {}), slateWater: true };
  let plugin: WaterMaterialPlugin | null = null;
  if (customMaterial) mesh.material = customMaterial;
  else {
    const material = new PBRMaterial(`${name}:water`, scene);
    configureWaterMaterial(material, water);
    plugin = new WaterMaterialPlugin(material, water, body);
    mesh.material = material;
    mesh.onDisposeObservable.addOnce(() => material.dispose());
  }
  const empty = new Float32Array();
  const surface: Surface = { mesh, water, body, plugin, layout: "", base: empty, positions: empty, normals: empty, baseNormals: empty, data: empty, flow: empty, spacing: empty };
  let entries = surfaces.get(scene);
  if (!entries) {
    entries = new Set(); surfaces.set(scene, entries);
    const observer = scene.onBeforeRenderObservable.add(() => updateSceneWater(scene));
    scene.onDisposeObservable.addOnce(() => { scene.onBeforeRenderObservable.remove(observer); surfaces.delete(scene); clocks.delete(scene); });
  }
  entries.add(surface);
  mesh.onDisposeObservable.addOnce(() => entries.delete(surface));
  updateSurface(surface, clocks.get(scene)?.time ?? 0);
  return mesh;
}
