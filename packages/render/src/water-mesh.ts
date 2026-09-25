import { Mesh, PBRMaterial, Vector3, VertexBuffer, VertexData, type Material, type Scene } from "@babylonjs/core";
import { createDefaultWaterDefinition, normalizeWaterBody, normalizeWaterDefinition, sampleWaterWaves, waterFootprint, type WaterBodyProperties, type WaterDefinition } from "@babylonslate/core";
import { configureWaterMaterial, WaterMaterialPlugin } from "./water-material";

type Surface = { mesh: Mesh; water: WaterDefinition; body: WaterBodyProperties; base: Float32Array; positions: Float32Array; normals: Float32Array; slopes: Float32Array; data: Float32Array; plugin: WaterMaterialPlugin | null };
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
  for (const surface of surfaces.get(scene) ?? []) updateSurface(surface, clock.time);
}

function updateSurface(s: Surface, time: number): void {
  let offsetX = 0, offsetZ = 0;
  if (s.body.kind === "ocean") {
    const camera = s.mesh.getScene().activeCamera;
    if (camera) {
      const local = Vector3.TransformCoordinates(camera.globalPosition, s.mesh.computeWorldMatrix(true).clone().invert());
      const dx = s.body.width / s.body.resolution, dz = s.body.length / s.body.resolution;
      offsetX = Math.round(local.x / dx) * dx;
      offsetZ = Math.round(local.z / dz) * dz;
    }
  }
  for (let i = 0; i < s.base.length; i += 3) {
    const x = s.base[i]! + offsetX, z = s.base[i + 2]! + offsetZ;
    const wave = sampleWaterWaves(s.water, x, z, time, s.body.waveScale);
    s.positions[i] = x; s.positions[i + 1] = s.base[i + 1]! + wave.height; s.positions[i + 2] = z;
    // Add the centreline's base slope to the wave normal for sloped rivers.
    const dx = s.slopes[i / 3 * 2]!, dz = s.slopes[i / 3 * 2 + 1]!;
    const nx = wave.normal.x / wave.normal.y - dx, nz = wave.normal.z / wave.normal.y - dz, length = Math.hypot(nx, 1, nz);
    s.data[i / 3 * 4] = wave.height; s.data[i / 3 * 4 + 3] = time;
    s.normals[i] = nx / length; s.normals[i + 1] = 1 / length; s.normals[i + 2] = nz / length;
  }
  s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, true);
  s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals);
  s.mesh.updateVerticesData("slateWaterData", s.data);
  if (s.plugin) s.plugin.time = time;
}

function riverPoint(body: WaterBodyProperties, along: number, across: number): [number, number] {
  const distances = body.points.slice(1).map((p, i) => Math.hypot(p[0] - body.points[i]![0], p[2] - body.points[i]![2]));
  const total = distances.reduce((a, b) => a + b, 0);
  const distance = along * (total + body.width) - body.width / 2;
  let remaining = Math.max(0, Math.min(total, distance));
  let segment = 0;
  while (segment < distances.length - 1 && remaining > distances[segment]!) remaining -= distances[segment++]!;
  const a = body.points[segment]!, b = body.points[segment + 1]!;
  const length = Math.max(1e-6, distances[segment]!);
  const dx = (b[0] - a[0]) / length, dz = (b[2] - a[2]) / length, t = remaining / length;
  const outside = distance < 0 ? distance : distance > total ? distance - total : 0;
  const radius = body.width / 2;
  const halfWidth = Math.sqrt(Math.max(0, radius * radius - outside * outside));
  return [a[0] + (b[0] - a[0]) * t + dx * outside - dz * across * halfWidth, a[2] + (b[2] - a[2]) * t + dz * outside + dx * across * halfWidth];
}

/** Runtime geometry is bounded by the component resolution and owns its native resources. */
export function createWaterMesh(scene: Scene, name: string, input: WaterBodyProperties, definition?: WaterDefinition, customMaterial?: Material | null): Mesh {
  const body = normalizeWaterBody(input, input.kind), water = normalizeWaterDefinition(definition ?? createDefaultWaterDefinition());
  const mesh = new Mesh(name, scene);
  mesh.setEnabled(body.enabled);
  mesh.metadata = { ...(mesh.metadata ?? {}), slateWater: true };
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], waterData: number[] = [], flow: number[] = [], slopes: number[] = [], indices: number[] = [];
  const rows = body.resolution, columns = body.kind === "river" ? Math.min(16, rows) : rows;
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const u = column / columns * 2 - 1, v = row / rows * 2 - 1;
    let x = u * body.width / 2, z = v * body.length / 2;
    if (body.kind === "river") [x, z] = riverPoint(body, row / rows, u);
    else if (body.kind !== "ocean") { x *= Math.sqrt(1 - v * v / 2); z *= Math.sqrt(1 - u * u / 2); }
    const footprint = waterFootprint(body, x, z);
    positions.push(x, footprint.height, z); normals.push(0, 1, 0);
    uvs.push(column / columns, row / rows);
    waterData.push(0, Math.min(10000, Math.max(0, footprint.edge)), body.depth, 0);
    flow.push(footprint.flowX * body.flowSpeed, footprint.flowY * body.flowSpeed, footprint.flowZ * body.flowSpeed);
    slopes.push(footprint.slopeX, footprint.slopeZ);
    if (row < rows && column < columns) {
      const a = row * (columns + 1) + column, b = a + columns + 1;
      // Rivers traverse the left side of their centreline first; ellipse/ocean
      // grids traverse X from left to right. Keep both top faces front-facing
      // under Babylon's clockwise convention, including single-sided materials.
      if (body.kind === "river") indices.push(a, b, a + 1, a + 1, b, b + 1);
      else indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const data = new VertexData();
  data.positions = positions; data.normals = normals; data.indices = indices; data.uvs = uvs;
  data.applyToMesh(mesh, true);
  mesh.setVerticesData("slateWaterData", waterData, true, 4);
  mesh.setVerticesData("slateWaterFlow", flow, false, 3);
  let plugin: WaterMaterialPlugin | null = null;
  if (customMaterial) mesh.material = customMaterial;
  else {
    const material = new PBRMaterial(`${name}:water`, scene);
    configureWaterMaterial(material, water);
    plugin = new WaterMaterialPlugin(material, water, body);
    mesh.material = material;
    mesh.onDisposeObservable.addOnce(() => material.dispose());
  }
  const surface: Surface = { mesh, water, body, base: new Float32Array(positions), positions: new Float32Array(positions), normals: new Float32Array(normals), slopes: new Float32Array(slopes), data: new Float32Array(waterData), plugin };
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
