import { Matrix, Mesh, PBRMaterial, Vector3, VertexBuffer, VertexData, type Material, type Scene } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, sampleWaterWaves, waterFootprint, waterRiverCentreline, type WaterBodyProperties, type WaterDefinition } from "@babylonslate/core";
import { configureWaterMaterial, contactRange, WaterMaterialPlugin } from "./water-material";
import { WaterField } from "./water-field";
import { WaterReflection } from "./water-reflection";

type Surface = {
  mesh: Mesh; water: WaterDefinition; body: WaterBodyProperties; plugin: WaterMaterialPlugin | null; field: WaterField | null;
  world: Matrix; inverse: Matrix;
  layout: string; frame: string; version: number; base: Float32Array; worldBase: Float32Array; positions: Float32Array; normals: Float32Array;
  baseNormals: Float32Array; data: Float32Array; flow: Float32Array; spacing: Float32Array;
};
const surfaces = new WeakMap<Scene, Set<Surface>>();
const surfaceByMesh = new WeakMap<Mesh, Surface>();
const clocks = new WeakMap<Scene, { time: number; runtime: boolean }>();
const reflections = new WeakMap<Scene, WaterReflection>();

export function sceneHasWater(scene: Scene): boolean { return (surfaces.get(scene)?.size ?? 0) > 0; }
export function setSceneWaterTime(scene: Scene, seconds: number): void {
  if (Number.isFinite(seconds)) clocks.set(scene, { time: seconds, runtime: true });
}

/** Called once per scene render; runtime water advances only with the worker clock. */
export function updateSceneWater(scene: Scene): void {
  const clock = clocks.get(scene) ?? { time: 0, runtime: false };
  if (!clock.runtime) clock.time += Math.min(0.1, scene.getEngine().getDeltaTime() / 1000 || 0);
  clocks.set(scene, clock);
  reflections.get(scene)?.sync();
  const now = performance.now();
  for (const surface of surfaces.get(scene) ?? []) if (surface.mesh.isEnabled()) {
    updateSurface(surface, clock.time);
    surface.field?.update(now);
  }
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

/** Cells along one axis of a finite volume: world-sized and fixed, never camera-dependent. */
const FINITE_CELL_BUDGET = 160;
const RIVER_ROW_BUDGET = 512;
function uniformAxis(min: number, max: number, worldLength: number, step: number): number[] {
  const count = Math.min(FINITE_CELL_BUDGET, Math.max(12, Math.ceil(worldLength / step / 2) * 2));
  return Array.from({ length: count + 1 }, (_, i) => min + (max - min) * i / count);
}

type RiverRow = { x: number; z: number; tx: number; tz: number; halfWidth: number };

/** Rows across the sampled centreline, including rounded end caps that match the query footprint. */
function riverRows(body: WaterBodyProperties, sx: number, sz: number, step: number): RiverRow[] {
  const line = waterRiverCentreline(body);
  const rows: RiverRow[] = [];
  const tangent = (i: number) => {
    const a = line[Math.max(0, i - 1)]!, b = line[Math.min(line.length - 1, i + 1)]!;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz) || 1;
    return [dx / length, dz / length] as const;
  };
  const cap = (index: number, direction: number) => {
    const p = line[index]!, [tx, tz] = tangent(index), count = 6;
    for (let k = 0; k < count; k++) {
      const f = direction < 0 ? 1 - k / count : (k + 1) / count;
      const outside = f * p.halfWidth;
      const halfWidth = Math.sqrt(Math.max(0, p.halfWidth * p.halfWidth - outside * outside));
      rows.push({ x: p.x + tx * outside * direction, z: p.z + tz * outside * direction, tx, tz, halfWidth });
    }
  };
  cap(0, -1);
  let budget = RIVER_ROW_BUDGET;
  for (let i = 0; i < line.length; i++) {
    const p = line[i]!, [tx, tz] = tangent(i);
    rows.push({ x: p.x, z: p.z, tx, tz, halfWidth: p.halfWidth });
    const next = line[i + 1];
    if (!next) break;
    const length = Math.hypot((next.x - p.x) * sx, (next.z - p.z) * sz);
    const splits = Math.max(1, Math.min(Math.ceil(length / step), Math.floor(budget / Math.max(1, line.length - i))));
    budget -= splits;
    const [nx, nz] = tangent(i + 1);
    for (let k = 1; k < splits; k++) {
      const t = k / splits, mx = tx + (nx - tx) * t, mz = tz + (nz - tz) * t, m = Math.hypot(mx, mz) || 1;
      rows.push({ x: p.x + (next.x - p.x) * t, z: p.z + (next.z - p.z) * t, tx: mx / m, tz: mz / m, halfWidth: p.halfWidth + (next.halfWidth - p.halfWidth) * t });
    }
  }
  cap(line.length - 1, 1);
  return rows;
}

function updateLayout(s: Surface, world: Matrix, inverse: Matrix): void {
  const { body, water, mesh } = s;
  const m = world.m;
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const step = Math.max(0.025, water.waveLength / 12 * 48 / body.resolution);
  let xs: number[], zs: number[], strip: RiverRow[] | null = null;
  let key: string;
  if (body.kind === "global") {
    const camera = mesh.getScene().activeCamera;
    // Read the camera's current position, including a parent, without waiting for Scene.render's camera update.
    const cameraWorld = camera ? (camera.parent ? Vector3.TransformCoordinates(camera.position, camera.parent.getWorldMatrix()) : camera.position) : Vector3.Zero();
    const local = Vector3.TransformCoordinates(cameraWorld, inverse);
    const extent = Math.max(256, (camera?.maxZ ?? 1000) * 1.2);
    const cx = Math.round(local.x * sx / step) * step / sx, cz = Math.round(local.z * sz / step) * step / sz;
    const budget = Math.max(32, body.resolution + body.resolution % 2);
    xs = axis(cx - extent / sx, cx + extent / sx, step / sx, cx, budget);
    zs = axis(cz - extent / sz, cz + extent / sz, step / sz, cz, budget);
    key = `${cx},${cz},${extent}`;
  } else if (body.kind === "river") {
    strip = riverRows(body, sx, sz, step);
    const widest = Math.max(...strip.map((row) => row.halfWidth)) * 2 * Math.max(sx, sz);
    const columns = Math.min(64, Math.max(4, Math.ceil(widest / step / 2) * 2));
    xs = Array.from({ length: columns + 1 }, (_, i) => i / columns * 2 - 1);
    zs = strip.map((_, i) => i);
    key = `${step}`;
  } else {
    xs = uniformAxis(-body.width / 2, body.width / 2, body.width * sx, step);
    zs = uniformAxis(-body.length / 2, body.length / 2, body.length * sz, step);
    key = `${step}`;
  }
  // Finite layouts depend only on the body and the volume's rotation/scale, so the camera never reshapes them.
  const layout = Array.from(world.m).slice(0, 12).join(",") + ":" + s.version + ":" + key;
  if (layout === s.layout) return;
  s.layout = layout;
  const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
  const columns = xs.length - 1, rows = zs.length - 1;
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    let x = xs[col]!, z = zs[row]!;
    if (strip) {
      const r = strip[row]!, across = x * r.halfWidth;
      x = r.x - r.tz * across; z = r.z + r.tx * across;
      // Mitred rows on widening bends can overhang the swept bank by millimetres; keep float32 vertices queryable.
      const bank = waterFootprint(body, x, z);
      if (bank.edge < 1e-4) { x += bank.edgeX * (bank.edge - 1e-4); z += bank.edgeZ * (bank.edge - 1e-4); }
    }
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
  s.worldBase = new Float32Array(positions.length);
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
  s.world.copyFrom(world); s.inverse.copyFrom(inverse);
  updateLayout(s, world, inverse);
  const frame = s.layout + ":" + [world.m[12], world.m[13], world.m[14]].join(",");
  const moved = frame !== s.frame;
  s.frame = frame;
  const up = Vector3.TransformNormal(Vector3.Up(), inverse);
  const depth = s.body.depth * Vector3.TransformNormal(Vector3.Up(), world).length();
  const point = new Vector3(), baseNormal = new Vector3(), localNormal = new Vector3(), flow = new Vector3(), edge = new Vector3();
  for (let i = 0; i < s.base.length; i += 3) {
    const x = s.base[i]!, y = s.base[i + 1]!, z = s.base[i + 2]!;
    const d = i / 3 * 4;
    if (moved) {
      point.set(x, y, z); Vector3.TransformCoordinatesToRef(point, world, point); point.toArray(s.worldBase, i);
      const footprint = waterFootprint(s.body, x, z);
      baseNormal.set(-footprint.slopeX, 1, -footprint.slopeZ);
      Vector3.TransformNormalToRef(baseNormal, normalMatrix, baseNormal);
      baseNormal.scaleInPlace(baseNormal.y < 0 ? -1 : 1).normalize();
      baseNormal.toArray(s.baseNormals, i);
      edge.set(footprint.edgeX, 0, footprint.edgeZ); Vector3.TransformNormalToRef(edge, normalMatrix, edge);
      flow.set(footprint.flowX, footprint.flowY, footprint.flowZ); Vector3.TransformNormalToRef(flow, world, flow);
      flow.scaleInPlace(s.body.flowSpeed / Math.max(1e-6, Math.hypot(flow.x, flow.z))).toArray(s.flow, i);
      s.data[d + 1] = Math.min(10000, Math.max(0, footprint.edge / (edge.length() || 1)));
      s.data[d + 2] = depth;
    }
    const wave = sampleWaterWaves(s.water, s.worldBase[i]!, s.worldBase[i + 2]!, time, s.body.waveScale, s.spacing[i / 3]);
    s.positions[i] = x + up.x * wave.height; s.positions[i + 1] = y + up.y * wave.height; s.positions[i + 2] = z + up.z * wave.height;
    baseNormal.copyFromFloats(s.baseNormals[i]!, s.baseNormals[i + 1]!, s.baseNormals[i + 2]!);
    const ny = Math.max(1e-6, baseNormal.y);
    localNormal.set(baseNormal.x / ny + wave.normal.x / wave.normal.y, 1, baseNormal.z / ny + wave.normal.z / wave.normal.y);
    Vector3.TransformNormalToRef(localNormal, toLocalNormal, localNormal); localNormal.normalize().toArray(s.normals, i);
    s.data[d] = wave.height; s.data[d + 3] = time;
  }
  s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, true);
  s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals);
  s.mesh.updateVerticesData("slateWaterData", s.data);
  if (moved) {
    s.mesh.updateVerticesData("slateWaterFlow", s.flow);
    s.mesh.updateVerticesData("slateWaterBaseNormal", s.baseNormals);
  }
  if (s.plugin) s.plugin.time = time;
}

const scratch = new Vector3();
/** Rest surface height (no waves) at a world X/Z, or null outside the body's footprint. */
function waterSurfaceY(s: Surface, x: number, z: number): number | null {
  Vector3.TransformCoordinatesFromFloatsToRef(x, s.world.m[13]!, z, s.inverse, scratch);
  const footprint = waterFootprint(s.body, scratch.x, scratch.z);
  if (!footprint.inside) return null;
  Vector3.TransformCoordinatesFromFloatsToRef(scratch.x, footprint.height, scratch.z, s.world, scratch);
  return scratch.y;
}

/** The live body of a built water mesh, or null for other meshes. */
export function waterMeshBody(mesh: Mesh): Readonly<WaterBodyProperties> | null {
  return surfaceByMesh.get(mesh)?.body ?? null;
}

/**
 * Reshape a water mesh in place, e.g. while an editor handle drags. The authored
 * component remains the source of truth; a committed change rebuilds the mesh.
 */
export function updateWaterMeshBody(mesh: Mesh, input: unknown): boolean {
  const surface = surfaceByMesh.get(mesh);
  if (!surface) return false;
  Object.assign(surface.body, normalizeWaterBody(input, surface.body.kind));
  surface.version++; surface.layout = ""; surface.frame = "";
  mesh.setEnabled(surface.body.enabled);
  updateSurface(surface, clocks.get(mesh.getScene())?.time ?? 0);
  surface.field?.update(performance.now(), true);
  return true;
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
    plugin.mesh = mesh;
    let reflection = reflections.get(scene);
    if (!reflection) { reflection = new WaterReflection(scene); reflections.set(scene, reflection); }
    reflection.add(material);
    mesh.material = material;
    mesh.onDisposeObservable.addOnce(() => material.dispose());
  }
  const empty = new Float32Array();
  const surface: Surface = { mesh, water, body, plugin, field: null, world: Matrix.Identity(), inverse: Matrix.Identity(), layout: "", frame: "", version: 0, base: empty, worldBase: empty, positions: empty, normals: empty, baseNormals: empty, data: empty, flow: empty, spacing: empty };
  let entries = surfaces.get(scene);
  if (!entries) {
    entries = new Set(); surfaces.set(scene, entries);
    const observer = scene.onBeforeRenderObservable.add(() => updateSceneWater(scene));
    scene.onDisposeObservable.addOnce(() => { scene.onBeforeRenderObservable.remove(observer); surfaces.delete(scene); clocks.delete(scene); reflections.delete(scene); });
  }
  entries.add(surface);
  surfaceByMesh.set(mesh, surface);
  mesh.onDisposeObservable.addOnce(() => entries.delete(surface));
  updateSurface(surface, clocks.get(scene)?.time ?? 0);
  if (plugin) {
    const field = new WaterField(scene, {
      mesh, unbounded: body.kind === "global", contactRange: contactRange(water),
      amplitude: water.waveHeight * body.waveScale * 1.3 + 0.05,
      surfaceY: (x, z) => waterSurfaceY(surface, x, z),
    });
    surface.field = field; plugin.field = field;
    field.update(performance.now(), true);
    mesh.onDisposeObservable.addOnce(() => field.dispose());
  }
  return mesh;
}
