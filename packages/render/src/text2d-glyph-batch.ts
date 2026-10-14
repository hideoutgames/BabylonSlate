import { VertexData } from "@babylonjs/core";

/**
 * Rest pose of one glyph plane inside its text root: the plane a glyph used to
 * get as its own mesh, with Babylon's scale, then rotation about Z, then
 * translation. A batch bakes this pose into its vertices.
 */
export type GlyphBatchQuad = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Radians about Z (MSDF italic shear). */
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Atlas rectangle; without one the quad keeps a plane's 0..1 UVs. */
  uvs?: { u0: number; v0: number; u1: number; v1: number };
};

/** Corner order of Babylon's `CreatePlane`, which the glyph UVs and winding follow. */
const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const;

/**
 * Write each quad's four corners (x, y, z) into `positions`. `counterX` and
 * `counterY` shrink the glyph shape about its own centre, as an overlay-box
 * resize does so letters keep their size while the box scales.
 */
export function writeGlyphBatchPositions(
  quads: readonly GlyphBatchQuad[],
  positions: Float32Array,
  counterX = 1,
  counterY = 1,
): void {
  let offset = 0;
  for (const quad of quads) {
    const cos = Math.cos(quad.rotation);
    const sin = Math.sin(quad.rotation);
    const width = quad.width * quad.scaleX * counterX;
    const height = quad.height * quad.scaleY * counterY;
    for (const [cornerX, cornerY] of CORNERS) {
      const x = cornerX * width;
      const y = cornerY * height;
      positions[offset++] = x * cos - y * sin + quad.x;
      positions[offset++] = x * sin + y * cos + quad.y;
      positions[offset++] = 0;
    }
  }
}

/** Four vertices and two triangles per quad, in quad order, like that many plane meshes concatenated. */
export function glyphBatchVertexData(quads: readonly GlyphBatchQuad[]): VertexData {
  const vertices = quads.length * 4;
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const indices = vertices > 65535 ? new Uint32Array(quads.length * 6) : new Uint16Array(quads.length * 6);
  writeGlyphBatchPositions(quads, positions);
  quads.forEach((quad, index) => {
    const base = index * 4;
    const { u0, v0, u1, v1 } = quad.uvs ?? { u0: 0, v0: 0, u1: 1, v1: 1 };
    uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], base * 2);
    for (let corner = 0; corner < 4; corner++) normals[(base + corner) * 3 + 2] = -1;
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], index * 6);
  });
  const data = new VertexData();
  data.positions = positions;
  data.normals = normals;
  data.uvs = uvs;
  data.indices = indices;
  return data;
}
