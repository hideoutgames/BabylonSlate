/**
 * A water surface's per-vertex rest inputs (world rest points, rest normals, current, bank distance and gradient,
 * depth) and their uploads, for the whole grid or a range of vertices.
 */
import { Matrix, Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import { waterFootprint } from "@haptic/core";
import { L_CX, L_CZ, type RestBuffers, type Surface } from "./water-mesh-surface";

const normalMatrix = new Matrix();
const point = new Vector3(), baseNormal = new Vector3(), localNormal = new Vector3(), flowVector = new Vector3(), edge = new Vector3();
const globalFlow = new Vector3(), globalNormal = new Vector3();

/** Whether the surface uploads its Global grid relative to the snapped centre, which the shader adds back (`gridOffset`). */
export const centredGrid = (s: Surface) => s.gpu && s.body.kind === "global";

/**
 * Fills `positions` for vertices [first, end) from `base`. A GPU Global grid is uploaded relative to its snapped centre
 * (`gridOffset`), so these values depend only on the grid lines and the blend lift, never on where the grid currently
 * is: a recentre leaves them, and the uploaded buffer, as they are. The centre is subtracted from the grid line, not
 * from the float32 `base`, so open water's positions are exactly the lines.
 */
export function writeRestPositions(s: Surface, first: number, end: number): void {
  const base = s.base, out = s.positions;
  if (!centredGrid(s)) { out.set(base.subarray(first * 3, end * 3), first * 3); return; }
  const stride = s.layoutColumns + 1, cx = s.layoutState[L_CX]!, cz = s.layoutState[L_CZ]!, xs = s.gridX, zs = s.gridZ;
  for (let v = first; v < end; v++) {
    const i = v * 3, col = v % stride, row = (v - col) / stride;
    // The blend lift's X/Z part (zero unless the volume is tilted) is the only difference from the lines.
    out[i] = xs[col]! + (base[i]! - Math.fround(cx + xs[col]!));
    out[i + 1] = base[i + 1]!;
    out[i + 2] = zs[row]! + (base[i + 2]! - Math.fround(cz + zs[row]!));
  }
}

/**
 * Per-vertex rest inputs of vertices [first, end) of `b` for the volume's `world` and `inverse`: world rest point,
 * footprint-derived normals, bank distance and gradient, flow and the GPU path's static vertex data. `blended` takes the
 * blend's union bank distance, depth and current (`blendRest`) wherever a neighbour reaches.
 */
export function restDataRange(s: Surface, b: RestBuffers, world: Matrix, inverse: Matrix, blended: boolean, first: number, end: number): void {
  inverse.transposeToRef(normalMatrix);
  const depth = s.body.depth * Vector3.TransformNormalFromFloatsToRef(0, 1, 0, world, point).length();
  for (let n = first; n < end; n++) {
    const i = n * 3, x = b.base[i]!, y = b.base[i + 1]!, z = b.base[i + 2]!;
    const d = n * 4, v = n * 2;
    Vector3.TransformCoordinatesFromFloatsToRef(x, y, z, world, point).toArray(b.worldBase, i);
    const footprint = waterFootprint(s.body, x, z);
    baseNormal.set(-footprint.slopeX, 1, -footprint.slopeZ);
    // The GPU path's vertex normal is the rest normal: the fragment shader derives its own from the swell.
    if (s.gpu) localNormal.copyFrom(baseNormal).normalize().toArray(b.normals, i);
    Vector3.TransformNormalToRef(baseNormal, normalMatrix, baseNormal);
    baseNormal.scaleInPlace(baseNormal.y < 0 ? -1 : 1).normalize();
    baseNormal.toArray(b.baseNormals, i);
    edge.set(footprint.edgeX, 0, footprint.edgeZ); Vector3.TransformNormalToRef(edge, normalMatrix, edge);
    const outward = edge.length() || 1;
    b.bankGradient[v] = -edge.x / outward; b.bankGradient[v + 1] = -edge.z / outward;
    flowVector.set(footprint.flowX, footprint.flowY, footprint.flowZ); Vector3.TransformNormalToRef(flowVector, world, flowVector);
    flowVector.scaleInPlace(s.body.flowSpeed / Math.max(1e-6, Math.hypot(flowVector.x, flowVector.z))).toArray(b.flow, i);
    b.data[d + 1] = Math.min(10000, Math.max(0, footprint.edge / outward));
    b.data[d + 2] = depth;
    const r = n * 6;
    // A blending grid keeps its own bank distance signed: an extended grid discards past it.
    if (blended) b.data[d + 1] = Math.min(10000, Math.max(-10000, footprint.edge / outward));
    if (blended && !Number.isNaN(b.blendRest[r]!)) {
      // Blending: the union shoreline (negative outside it, where the fragment discards), blended depth and current.
      b.data[d + 1] = b.blendRest[r]!; b.data[d + 2] = b.blendRest[r + 1]!;
      b.flow[i] = b.blendRest[r + 2]!; b.flow[i + 1] = b.blendRest[r + 3]!; b.flow[i + 2] = b.blendRest[r + 4]!;
    }
    // The GPU path's static vertex inputs: the spacing filter replaces the CPU height; time is a uniform.
    if (s.gpu) { b.data[d] = s.spacing[n]!; b.data[d + 3] = 0; }
  }
}

/** Uploads the whole grid's rest inputs after `placeRestData` or a landed blend refresh wrote them. */
export function uploadRestData(s: Surface, blended: boolean): void {
  s.mesh.updateVerticesData("slateWaterFlow", s.flow);
  s.mesh.updateVerticesData("slateWaterBaseNormal", s.baseNormals);
  if (blended) {
    s.mesh.updateVerticesData("slateWaterBlend", s.blendData);
    s.mesh.updateVerticesData("slateWaterBlendColors", s.blendColors);
  }
  if (s.gpu) {
    // A static rest grid: the vertex shader adds every displacement and computes its own offsets.
    if (!s.offsetsZero) { s.offsets.fill(0); s.offsetsZero = true; s.mesh.updateVerticesData("slateWaterOffset", s.offsets); }
    writeRestPositions(s, 0, s.base.length / 3);
    s.mesh.updateVerticesData(VertexBuffer.PositionKind, s.positions, false);
    s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals);
    s.mesh.updateVerticesData("slateWaterData", s.data);
  }
  // CPU vertices resample at the next animation step even while the clock is paused.
  s.time = null;
}

/** Uploads vertices [first, end) of one attribute in place (`data` is the buffer's own CPU array), else all of it. */
function uploadVertexRange(mesh: Mesh, kind: string, data: Float32Array, stride: number, first: number, end: number): void {
  const vertexBuffer = mesh.getVertexBuffer(kind), buffer = vertexBuffer?.getBuffer();
  if (!vertexBuffer || !buffer || !vertexBuffer.isUpdatable() || vertexBuffer.getData() !== data || end <= first) {
    mesh.updateVerticesData(kind, data);
    return;
  }
  mesh.getEngine().updateDynamicVertexBuffer(buffer, data.subarray(first * stride, end * stride), first * stride * 4);
}

/**
 * Open-water rest data for the vertices [first, end) of a blending Global grid in `b` (`blendRest` marks them with NaN,
 * or holds the blended union bank distance, depth and current): the fill `placeRestData` does for every vertex, and
 * unit normals for `blendNormals` to fit over.
 */
export function globalRestRange(s: Surface, b: RestBuffers, world: Matrix, inverse: Matrix, first: number, end: number): void {
  const rest = b.blendRest;
  const depth = s.body.depth * Vector3.TransformNormalFromFloatsToRef(0, 1, 0, world, point).length();
  globalFlow.set(Math.cos(s.body.flowDirection * Math.PI / 180), 0, Math.sin(s.body.flowDirection * Math.PI / 180));
  Vector3.TransformNormalToRef(globalFlow, world, globalFlow);
  globalFlow.scaleInPlace(s.body.flowSpeed / Math.max(1e-6, Math.hypot(globalFlow.x, globalFlow.z)));
  inverse.transposeToRef(normalMatrix);
  Vector3.TransformNormalFromFloatsToRef(0, 1, 0, normalMatrix, globalNormal);
  globalNormal.scaleInPlace(globalNormal.y < 0 ? -1 : 1).normalize();
  for (let v = first; v < end; v++) {
    const i = v * 3, d = v * 4, r = v * 6, own = Number.isNaN(rest[r]!);
    b.data[d + 1] = own ? 10000 : rest[r]!; b.data[d + 2] = own ? depth : rest[r + 1]!;
    b.flow[i] = own ? globalFlow.x : rest[r + 2]!; b.flow[i + 1] = own ? globalFlow.y : rest[r + 3]!; b.flow[i + 2] = own ? globalFlow.z : rest[r + 4]!;
    globalNormal.toArray(b.baseNormals, i);
    b.normals[i] = 0; b.normals[i + 1] = 1; b.normals[i + 2] = 0;
  }
}

/** Uploads vertices [first, end) of a Global grid's positions and every blend-written attribute in place. */
export function uploadGlobalRows(s: Surface, begin: number, end: number): void {
  writeRestPositions(s, begin, end);
  uploadVertexRange(s.mesh, VertexBuffer.PositionKind, s.positions, 3, begin, end);
  uploadVertexRange(s.mesh, VertexBuffer.NormalKind, s.normals, 3, begin, end);
  uploadVertexRange(s.mesh, "slateWaterData", s.data, 4, begin, end);
  uploadVertexRange(s.mesh, "slateWaterFlow", s.flow, 3, begin, end);
  uploadVertexRange(s.mesh, "slateWaterBaseNormal", s.baseNormals, 3, begin, end);
  uploadVertexRange(s.mesh, "slateWaterBlend", s.blendData, 4, begin, end);
  uploadVertexRange(s.mesh, "slateWaterBlendColors", s.blendColors, 2, begin, end);
}
