import { decodeRadianceHdr, readRadianceHeader, type RadianceImage } from "./radiance-hdr";

/**
 * Import-time conversion of an equirectangular Radiance HDR into the
 * prefiltered linear RGBA16F DDS cube the renderer already loads, so games
 * never decode, project or filter HDR panoramas at load.
 *
 * Faces follow the WebGL cube map convention (+X, -X, +Y, -Y, +Z, -Z, first
 * row at t = 0) and the panorama is oriented as Babylon's HDRCubeTexture
 * orients it: the image centre faces +Z, +X is three quarters across and the
 * top row is +Y. Mip `i` holds the GGX radiance for alpha
 * 2^(i / 0.8) / size, matching Babylon's HDRFiltering and the 0.8 LOD scale a
 * prefiltered DDS CubeTexture samples with.
 */

/** Babylon's ENV standard; image-based lighting gains nothing from larger faces. */
export const HDR_ENVIRONMENT_MAX_FACE_SIZE = 256;
const LOD_GENERATION_SCALE = 0.8;
/** Babylon's realtime "high" quality, for the sharpest mip where texels are most numerous. */
const BASE_SAMPLE_COUNT = 64;
const MAX_SAMPLE_COUNT = 1024;
/** Babylon's filtered importance sampling bias (`K` in hdrFilteringFunctions). */
const FILTERING_K = 4;
const HALF_MAX = 65504;

export type CubeFaces = Float32Array[];

/** Power-of-two face size nearest a quarter of the panorama width, capped. */
export function hdrEnvironmentFaceSize(panoramaWidth: number): number {
  const quarter = Math.max(2, panoramaWidth / 4);
  return Math.min(HDR_ENVIRONMENT_MAX_FACE_SIZE, 2 ** Math.round(Math.log2(quarter)));
}

/** World direction of a texel centre on a WebGL cube face. */
export function cubeTexelDirection(face: number, size: number, x: number, y: number): [number, number, number] {
  const s = ((x + 0.5) / size) * 2 - 1;
  const t = ((y + 0.5) / size) * 2 - 1;
  let direction: [number, number, number];
  switch (face) {
    case 0: direction = [1, -t, -s]; break;
    case 1: direction = [-1, -t, s]; break;
    case 2: direction = [s, 1, t]; break;
    case 3: direction = [s, -1, -t]; break;
    case 4: direction = [s, -t, 1]; break;
    default: direction = [-s, -t, -1]; break;
  }
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function samplePanorama(image: RadianceImage, dx: number, dy: number, dz: number, out: Float32Array, at: number): void {
  const { width, height, rgb } = image;
  const u = 0.5 + Math.atan2(dx, dz) / (2 * Math.PI);
  const v = Math.acos(Math.max(-1, Math.min(1, dy))) / Math.PI;
  const fx = u * width - 0.5;
  const fy = Math.max(0, Math.min(height - 1, v * height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const xa = ((x0 % width) + width) % width;
  const xb = (xa + 1) % width;
  const ya = y0;
  const yb = Math.min(height - 1, y0 + 1);
  for (let channel = 0; channel < 3; channel++) {
    const top = rgb[(ya * width + xa) * 3 + channel]! * (1 - ax) + rgb[(ya * width + xb) * 3 + channel]! * ax;
    const bottom = rgb[(yb * width + xa) * 3 + channel]! * (1 - ax) + rgb[(yb * width + xb) * 3 + channel]! * ax;
    out[at + channel] = top * (1 - ay) + bottom * ay;
  }
}

/** Project an equirectangular panorama onto six RGB cube faces. */
export function equirectangularToCube(image: RadianceImage, size: number): CubeFaces {
  const faces: CubeFaces = [];
  for (let face = 0; face < 6; face++) {
    const pixels = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const [dx, dy, dz] = cubeTexelDirection(face, size, x, y);
        samplePanorama(image, dx, dy, dz, pixels, (y * size + x) * 3);
      }
    faces.push(pixels);
  }
  return faces;
}

function halveFaces(faces: CubeFaces, size: number): CubeFaces {
  const half = size / 2;
  return faces.map((pixels) => {
    const out = new Float32Array(half * half * 3);
    for (let y = 0; y < half; y++)
      for (let x = 0; x < half; x++)
        for (let channel = 0; channel < 3; channel++) {
          const at = (row: number, column: number) => pixels[(row * size + column) * 3 + channel]!;
          out[(y * half + x) * 3 + channel] =
            (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1)) / 4;
        }
    return out;
  });
}

/** Box-filtered mip chain through 1×1, as the GPU generates for the filter input. */
export function cubeMipChain(base: CubeFaces, size: number): CubeFaces[] {
  const levels = [base];
  for (let edge = size; edge > 1; edge /= 2) levels.push(halveFaces(levels[levels.length - 1]!, edge));
  return levels;
}

function radicalInverse(bits: number): number {
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits * 2.3283064365386963e-10;
}

/** Per-sample stride in the packed sample table: x, y, z, low mip, weight at low mip, weight at the next mip. */
const SAMPLE_STRIDE = 6;

/**
 * GGX importance samples around +Z (Babylon's Hammersley sequence and
 * `hemisphereImportanceSampleDggx` with V = N), each with the filtered
 * importance sampling source LOD split across its two nearest mips. Returns
 * the packed table and the total NoL weight.
 */
function ggxSamples(alpha: number, count: number, size: number, maxLevel: number): { table: Float64Array; total: number } {
  const table = new Float64Array(count * SAMPLE_STRIDE);
  const omegaP = (4 * Math.PI) / (6 * size * size);
  const log4 = (value: number) => Math.log2(value) / 2;
  const a2 = alpha * alpha;
  let used = 0;
  let total = 0;
  for (let index = 0; index < count; index++) {
    const phi = (2 * Math.PI * index) / count;
    const xi = radicalInverse(index);
    const cosTheta2 = (1 - xi) / (1 + (a2 - 1) * xi);
    const cosTheta = Math.sqrt(cosTheta2);
    const sinTheta = Math.sqrt(1 - cosTheta2);
    const noL = 2 * cosTheta2 - 1;
    if (noL <= 0) continue;
    const d = cosTheta2 * (a2 - 1) + 1;
    const ndf = a2 / (Math.PI * d * d);
    const omegaS = 4 / (ndf * count);
    const lod = Math.max(0, Math.min(maxLevel, log4(omegaS) - log4(omegaP) + log4(FILTERING_K)));
    const low = Math.min(Math.floor(lod), maxLevel - 1);
    const blend = lod - low;
    const lx = 2 * cosTheta * sinTheta * Math.cos(phi);
    const ly = 2 * cosTheta * sinTheta * Math.sin(phi);
    const length = Math.hypot(lx, ly, noL);
    table.set([lx / length, ly / length, noL / length, low, noL * (1 - blend), noL * blend], used * SAMPLE_STRIDE);
    used++;
    total += noL;
  }
  return { table: table.subarray(0, used * SAMPLE_STRIDE), total };
}

/**
 * Samples per mip. Fewer samples read blurrier source mips, which matters most
 * for rough lobes; each coarser mip has a quarter of the texels, so it can take
 * four times the samples for the same cost.
 */
function sampleCount(level: number): number {
  return Math.min(MAX_SAMPLE_COUNT, BASE_SAMPLE_COUNT * 4 ** (level - 1));
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Longest stretch of filtering before the import yields to the event loop. */
const YIELD_INTERVAL_MS = 32;

/** One output row of a prefiltered face: the GGX-weighted average of every sample in `table`. */
function filterRow(
  source: CubeFaces[],
  size: number,
  table: Float64Array,
  total: number,
  face: number,
  edge: number,
  y: number,
  pixels: Float32Array,
): void {
  for (let x = 0; x < edge; x++) {
    const [nx, ny, nz] = cubeTexelDirection(face, edge, x, y);
    // Babylon's tangent frame: tangent = normalize(cross(up, n)) with up = +Z
    // (or +X near the poles), bitangent = cross(n, tangent).
    const nearPole = Math.abs(nz) >= 0.999;
    let tx = nearPole ? 0 : -ny;
    let ty = nearPole ? -nz : nx;
    let tz = nearPole ? ny : 0;
    const tangentLength = Math.hypot(tx, ty, tz);
    tx /= tangentLength; ty /= tangentLength; tz /= tangentLength;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    let r = 0;
    let g = 0;
    let b = 0;
    // Hot loop: WebGL face selection and bilinear taps on the sample's two
    // source mips, inlined and clamped at face edges.
    for (let at = 0; at < table.length; at += SAMPLE_STRIDE) {
      const sx = table[at]!;
      const sy = table[at + 1]!;
      const sz = table[at + 2]!;
      const dx = tx * sx + bx * sy + nx * sz;
      const dy = ty * sx + by * sy + ny * sz;
      const dz = tz * sx + bz * sy + nz * sz;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      let target: number;
      let sc: number;
      let tc: number;
      let major: number;
      if (ax >= ay && ax >= az) {
        target = dx > 0 ? 0 : 1; sc = dx > 0 ? -dz : dz; tc = -dy; major = ax;
      } else if (ay >= az) {
        target = dy > 0 ? 2 : 3; sc = dx; tc = dy > 0 ? dz : -dz; major = ay;
      } else {
        target = dz > 0 ? 4 : 5; sc = dz > 0 ? dx : -dx; tc = -dy; major = az;
      }
      const s = (sc / major + 1) * 0.5;
      const t = (tc / major + 1) * 0.5;
      for (let tap = 0, mip = table[at + 3]!; tap < 2; tap++, mip++) {
        const weight = table[at + 4 + tap]!;
        if (weight === 0) continue;
        const n = size >> mip;
        const texels = source[mip]![target]!;
        let fx = s * n - 0.5;
        if (fx < 0) fx = 0; else if (fx > n - 1) fx = n - 1;
        let fy = t * n - 0.5;
        if (fy < 0) fy = 0; else if (fy > n - 1) fy = n - 1;
        const x0 = fx | 0;
        const y0 = fy | 0;
        const x1 = x0 + 1 < n ? x0 + 1 : x0;
        const y1 = y0 + 1 < n ? y0 + 1 : y0;
        const wx = fx - x0;
        const wy = fy - y0;
        const w00 = (1 - wx) * (1 - wy) * weight;
        const w10 = wx * (1 - wy) * weight;
        const w01 = (1 - wx) * wy * weight;
        const w11 = wx * wy * weight;
        const i00 = (y0 * n + x0) * 3;
        const i10 = (y0 * n + x1) * 3;
        const i01 = (y1 * n + x0) * 3;
        const i11 = (y1 * n + x1) * 3;
        r += texels[i00]! * w00 + texels[i10]! * w10 + texels[i01]! * w01 + texels[i11]! * w11;
        g += texels[i00 + 1]! * w00 + texels[i10 + 1]! * w10 + texels[i01 + 1]! * w01 + texels[i11 + 1]! * w11;
        b += texels[i00 + 2]! * w00 + texels[i10 + 2]! * w10 + texels[i01 + 2]! * w01 + texels[i11 + 2]! * w11;
      }
    }
    const at = (y * edge + x) * 3;
    pixels[at] = r / total;
    pixels[at + 1] = g / total;
    pixels[at + 2] = b / total;
  }
}

/**
 * GGX-prefiltered radiance for every mip of a cube, sampled from the
 * box-filtered `source` chain. Yields between scanlines so a long import keeps
 * the editor responsive.
 */
export async function prefilterCubeRadiance(source: CubeFaces[], size: number): Promise<CubeFaces[]> {
  const levels: CubeFaces[] = [source[0]!];
  const sourceLevels = source.length - 1;
  let lastYield = performance.now();
  for (let level = 1, edge = size / 2; edge >= 1; level++, edge /= 2) {
    const alpha = 2 ** (level / LOD_GENERATION_SCALE) / size;
    const { table, total } = ggxSamples(alpha, sampleCount(level), size, sourceLevels);
    const faces: CubeFaces = [];
    for (let face = 0; face < 6; face++) {
      const pixels = new Float32Array(edge * edge * 3);
      for (let y = 0; y < edge; y++) {
        if (performance.now() - lastYield > YIELD_INTERVAL_MS) {
          await nextTask();
          lastYield = performance.now();
        }
        filterRow(source, size, table, total, face, edge, y, pixels);
      }
      faces.push(pixels);
    }
    levels.push(faces);
  }
  return levels;
}

const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);

/** IEEE half with round-to-nearest-even; negatives and NaN become 0, overflow the largest half. */
export function toHalfFloat(value: number): number {
  if (!(value > 0)) return 0;
  if (value >= HALF_MAX) return 0x7bff;
  float32[0] = value;
  const bits = uint32[0]!;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return 0;
    const full = mantissa | 0x800000;
    const shift = 14 - exponent;
    let half = full >>> shift;
    const remainder = full & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    if (remainder > midpoint || (remainder === midpoint && half & 1)) half += 1;
    return half;
  }
  let half = (exponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && half & 1)) half += 1;
  return Math.min(half, 0x7bff);
}

/** Uncompressed RGBA16F (FourCC 113) cube DDS: faces in order, each with its full mip chain. */
export function encodeHalfFloatDdsCube(levels: CubeFaces[], size: number): Uint8Array<ArrayBuffer> {
  let texels = 0;
  for (let level = 0; level < levels.length; level++) texels += (size >> level) ** 2;
  const bytes = new Uint8Array(128 + texels * 6 * 8);
  const view = new DataView(bytes.buffer);
  const set = (offset: number, value: number) => view.setUint32(offset, value, true);
  bytes.set([0x44, 0x44, 0x53, 0x20]);
  set(4, 124);
  set(8, 0x2100f); // CAPS | HEIGHT | WIDTH | PITCH | PIXELFORMAT | MIPMAPCOUNT
  set(12, size);
  set(16, size);
  set(20, size * 8);
  set(28, levels.length);
  set(76, 32);
  set(80, 4); // FOURCC
  set(84, 113); // D3DFMT_A16B16G16R16F
  set(108, 0x401008); // COMPLEX | TEXTURE | MIPMAP
  set(112, 0xfe00); // CUBEMAP with all six faces
  let offset = 128;
  for (let face = 0; face < 6; face++)
    for (const level of levels) {
      const pixels = level[face]!;
      for (let index = 0; index < pixels.length; index += 3) {
        view.setUint16(offset, toHalfFloat(pixels[index]!), true);
        view.setUint16(offset + 2, toHalfFloat(pixels[index + 1]!), true);
        view.setUint16(offset + 4, toHalfFloat(pixels[index + 2]!), true);
        view.setUint16(offset + 6, 0x3c00, true);
        offset += 8;
      }
    }
  return bytes;
}

/** Equirectangular Radiance HDR to a prefiltered RGBA16F DDS environment cube. */
export async function convertRadianceHdrToEnvironmentDds(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const { width } = readRadianceHeader(bytes);
  const size = hdrEnvironmentFaceSize(width);
  // Keep about two panorama pixels per face texel; finer detail is filtered away.
  const panorama = decodeRadianceHdr(bytes, Math.max(1, Math.floor(width / (8 * size))));
  await nextTask();
  const base = equirectangularToCube(panorama, size);
  await nextTask();
  const levels = await prefilterCubeRadiance(cubeMipChain(base, size), size);
  return encodeHalfFloatDdsCube(levels, size);
}
