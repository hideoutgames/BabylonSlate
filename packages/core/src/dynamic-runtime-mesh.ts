/** Runtime-only geometry; scene documents persist component settings, never these buffers. */
export const DYNAMIC_RUNTIME_MESH_CLASS_ID = "DynamicRuntimeMeshComponent";

export type DynamicMeshBounds = { min: [number, number, number]; max: [number, number, number] };
export type DynamicMeshRange = { offset: number; data: Float32Array };
export type DynamicMeshUpdate = {
  revision: number;
  vertexCount: number;
  indexCount: number;
  reset: boolean;
  positions?: DynamicMeshRange;
  normals?: DynamicMeshRange;
  uvs?: DynamicMeshRange;
  indices?: Uint32Array;
  bounds: DynamicMeshBounds;
};

type Numbers = readonly number[] | Float32Array | Float64Array | Uint16Array | Uint32Array | Int32Array;
type Range = { start: number; end: number };
const MAX_VERTICES = 1_000_000;
const MAX_INDICES = 6_000_000;

function numbers(value: unknown): value is Numbers {
  return Array.isArray(value) || value instanceof Float32Array || value instanceof Float64Array ||
    value instanceof Uint16Array || value instanceof Uint32Array || value instanceof Int32Array;
}

function floats(value: unknown, stride: number, length?: number): value is Numbers {
  if (!numbers(value) || value.length % stride || value.length > MAX_VERTICES * stride ||
    length !== undefined && value.length !== length) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !Number.isFinite(value[i]) || Math.abs(value[i]!) > 1e10) return false;
  }
  return true;
}

function mark(range: Range, start: number, end: number): void {
  range.start = Math.min(range.start, start);
  range.end = Math.max(range.end, end);
}

/** Owned storage with coalesced dirty ranges. Unchanged frames allocate and transmit nothing. */
export class DynamicRuntimeMeshGeometry {
  positions = new Float32Array(0);
  normals = new Float32Array(0);
  uvs = new Float32Array(0);
  indices = new Uint32Array(0);
  revision = 0;
  /** Only positions/topology affect collision; normal/UV edits do not recook it. */
  collisionRevision = 0;
  readonly bounds: DynamicMeshBounds = { min: [0, 0, 0], max: [0, 0, 0] };
  private reset = false;
  private readonly dirtyPositions: Range = { start: Infinity, end: 0 };
  private readonly dirtyNormals: Range = { start: Infinity, end: 0 };
  private readonly dirtyUvs: Range = { start: Infinity, end: 0 };

  /** Validation is atomic. Caller arrays are copied and may be reused immediately. */
  setGeometry(positions: unknown, indices: unknown, normals?: unknown, uvs?: unknown): boolean {
    if (!floats(positions, 3) || !numbers(indices) || indices.length % 3 || indices.length > MAX_INDICES) return false;
    const count = positions.length / 3;
    if (!count || !indices.length) return false;
    for (let i = 0; i < indices.length; i++) {
      if (!Number.isInteger(indices[i]) || indices[i]! < 0 || indices[i]! >= count) return false;
    }
    const hasNormals = numbers(normals) && normals.length > 0;
    const hasUvs = numbers(uvs) && uvs.length > 0;
    if (normals != null && !floats(normals, 3, hasNormals ? positions.length : 0) ||
      uvs != null && !floats(uvs, 2, hasUvs ? count * 2 : 0)) return false;
    // Same-sized replacements retain CPU storage as well as the renderer's GPU allocation.
    if (this.positions.length !== positions.length) {
      this.positions = new Float32Array(positions.length);
      this.normals = new Float32Array(positions.length);
      this.uvs = new Float32Array(count * 2);
    }
    if (this.indices.length !== indices.length) this.indices = new Uint32Array(indices.length);
    this.positions.set(positions);
    this.indices.set(indices);
    if (hasNormals) this.normals.set(normals); else this.computeNormals();
    if (hasUvs) this.uvs.set(uvs); else this.uvs.fill(0);
    this.computeBounds();
    this.revision++;
    this.collisionRevision++;
    this.reset = true;
    return true;
  }

  /** Updates complete vertices at a vertex offset; omitted channels retain their values. */
  updateVertices(firstVertex: unknown, positions?: unknown, normals?: unknown, uvs?: unknown): boolean {
    if (!Number.isInteger(firstVertex) || (firstVertex as number) < 0) return false;
    const first = firstVertex as number;
    const inputs = [positions, normals, uvs];
    const strides = [3, 3, 2];
    let changed = false;
    for (let channel = 0; channel < 3; channel++) {
      const input = inputs[channel];
      const stride = strides[channel]!;
      if (input == null) continue;
      if (!floats(input, stride) || first + input.length / stride > this.positions.length / 3) return false;
      changed ||= input.length > 0;
    }
    if (!changed) return true;
    if (numbers(positions) && positions.length) {
      this.positions.set(positions, first * 3);
      mark(this.dirtyPositions, first * 3, first * 3 + positions.length);
      // Conservative expansion scans only the edited range. Explicit bounds refresh tightens it.
      this.expandBounds(first * 3, first * 3 + positions.length);
      this.collisionRevision++;
    }
    if (numbers(normals) && normals.length) {
      this.normals.set(normals, first * 3);
      mark(this.dirtyNormals, first * 3, first * 3 + normals.length);
    }
    if (numbers(uvs) && uvs.length) {
      this.uvs.set(uvs, first * 2);
      mark(this.dirtyUvs, first * 2, first * 2 + uvs.length);
    }
    this.revision++;
    return true;
  }

  recalculateNormals(): void {
    if (!this.positions.length) return;
    this.computeNormals();
    mark(this.dirtyNormals, 0, this.normals.length);
    this.revision++;
  }

  recalculateBounds(): void {
    this.computeBounds();
    this.revision++;
  }

  clear(): void {
    if (!this.positions.length && !this.indices.length) return;
    this.positions = new Float32Array(0);
    this.normals = new Float32Array(0);
    this.uvs = new Float32Array(0);
    this.indices = new Uint32Array(0);
    this.bounds.min.fill(0); this.bounds.max.fill(0);
    this.revision++; this.collisionRevision++;
    this.reset = true;
  }

  /** One owned copy of changed data, suitable for transfer without detaching live storage. */
  takeUpdate(full = false): DynamicMeshUpdate {
    const reset = full || this.reset;
    const update: DynamicMeshUpdate = {
      revision: this.revision, vertexCount: this.positions.length / 3, indexCount: this.indices.length, reset,
      bounds: { min: [...this.bounds.min], max: [...this.bounds.max] },
    };
    const copy = (data: Float32Array, range: Range): DynamicMeshRange | undefined =>
      reset ? { offset: 0, data: data.slice() } : range.end > range.start ? { offset: range.start, data: data.slice(range.start, range.end) } : undefined;
    update.positions = copy(this.positions, this.dirtyPositions);
    update.normals = copy(this.normals, this.dirtyNormals);
    update.uvs = copy(this.uvs, this.dirtyUvs);
    if (reset) update.indices = this.indices.slice();
    for (const range of [this.dirtyPositions, this.dirtyNormals, this.dirtyUvs]) { range.start = Infinity; range.end = 0; }
    this.reset = false;
    return update;
  }

  private computeBounds(): void {
    this.bounds.min.fill(this.positions.length ? Infinity : 0);
    this.bounds.max.fill(this.positions.length ? -Infinity : 0);
    this.expandBounds(0, this.positions.length);
  }

  private expandBounds(start: number, end: number): void {
    const { min, max } = this.bounds;
    for (let i = start; i < end; i += 3) for (let axis = 0; axis < 3; axis++) {
      const value = this.positions[i + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }

  private computeNormals(): void {
    const p = this.positions, n = this.normals, indices = this.indices;
    n.fill(0);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
      const ax = p[a]! - p[b]!, ay = p[a + 1]! - p[b + 1]!, az = p[a + 2]! - p[b + 2]!;
      const bx = p[c]! - p[b]!, by = p[c + 1]! - p[b + 1]!, bz = p[c + 2]! - p[b + 2]!;
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      n[a]! += nx; n[a + 1]! += ny; n[a + 2]! += nz;
      n[b]! += nx; n[b + 1]! += ny; n[b + 2]! += nz;
      n[c]! += nx; n[c + 1]! += ny; n[c + 2]! += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const length = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
      if (length) { n[i]! /= length; n[i + 1]! /= length; n[i + 2]! /= length; }
    }
  }
}
