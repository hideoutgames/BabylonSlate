import { sniffImageSize } from "./image-size";

const ENV_MAGIC = [0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36];

export interface EnvironmentTextureInfo {
  dimension: "cube";
  container: "env" | "dds";
  encoding: "rgbd" | "linearFloat16" | "linearFloat32";
  width: number;
  height: number;
  mipLevels: number;
  /** DDS is required to be authored as prefiltered; headers cannot prove convolution. */
  prefiltered: true;
  /** Irradiance supplied in the source; DDS may derive a polynomial on load. */
  hasIrradiance: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cubeSize(value: unknown): value is number {
  return positiveInteger(value) && Number.isInteger(Math.log2(value));
}

function triple(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const text = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 20 || text(0) !== "RIFF" || text(8) !== "WEBP")
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return null;
  const u24 = (offset: number) =>
    bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true);
    if (offset + 8 + length > bytes.length) return null;
    const start = offset + 8;
    if (text(offset) === "VP8X" && length >= 10) {
      if (bytes[start]! & 2) return null; // Animated images are not cube faces.
      return { width: u24(start + 4) + 1, height: u24(start + 7) + 1 };
    }
    if (text(offset) === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
      const bits = view.getUint32(start + 1, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (
      text(offset) === "VP8 " &&
      length >= 10 &&
      bytes[start + 3] === 0x9d &&
      bytes[start + 4] === 1 &&
      bytes[start + 5] === 0x2a
    ) {
      return {
        width: view.getUint16(start + 6, true) & 0x3fff,
        height: view.getUint16(start + 8, true) & 0x3fff,
      };
    }
    offset += 8 + length + (length % 2);
  }
  return null;
}

export function environmentTextureContainer(
  bytes: Uint8Array,
): "env" | "dds" | null {
  if (
    bytes.length >= 8 &&
    ENV_MAGIC.every((value, index) => bytes[index] === value)
  )
    return "env";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x44 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x20
  )
    return "dds";
  return null;
}

/** Dimensional metadata prevents ordinary Texture parameters from admitting a cube. */
export function isEnvironmentTexturePayload(payload: unknown): boolean {
  return (
    record(payload) &&
    payload.dimension === "cube" &&
    (payload.container === "env" || payload.container === "dds")
  );
}

function readEnv(bytes: Uint8Array): EnvironmentTextureInfo {
  const end = bytes.subarray(8, Math.min(bytes.length, 1024 * 1024)).indexOf(0);
  if (end < 0)
    throw new Error(
      "ENV requires a terminated JSON header smaller than 1 MiB.",
    );
  let info: unknown;
  try {
    info = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(8, 8 + end),
      ),
    );
  } catch {
    throw new Error("ENV contains an invalid JSON header.");
  }
  if (
    !record(info) ||
    (info.version !== 1 && info.version !== 2) ||
    !cubeSize(info.width) ||
    info.width < 2
  ) {
    throw new Error(
      "ENV requires version 1 or 2 and a power-of-two cube width of at least 2 (the native ENV loader minimum).",
    );
  }
  const width = info.width;
  const mipLevels = 1 + Math.log2(width);
  const imageType = info.version === 1 ? "image/png" : info.imageType;
  if (imageType !== "image/png" && imageType !== "image/webp")
    throw new Error("ENV supports RGBD PNG or WebP face images.");
  if (
    !record(info.specular) ||
    !Array.isArray(info.specular.mipmaps) ||
    info.specular.mipmaps.length !== 6 * mipLevels
  ) {
    throw new Error("ENV requires all six faces of every specular mip level.");
  }
  if (
    info.specular.lodGenerationScale !== undefined &&
    (typeof info.specular.lodGenerationScale !== "number" ||
      !Number.isFinite(info.specular.lodGenerationScale) ||
      info.specular.lodGenerationScale <= 0)
  ) {
    throw new Error("ENV specular LOD scale must be positive and finite.");
  }
  const dataOffset = 9 + end;
  const ranges: Array<[number, number]> = [];
  const face = (value: unknown, expectedSize: number) => {
    if (
      !record(value) ||
      typeof value.position !== "number" ||
      !Number.isSafeInteger(value.position) ||
      value.position < 0 ||
      !positiveInteger(value.length) ||
      value.position + value.length > bytes.length - dataOffset
    ) {
      throw new Error("ENV face data is missing or exceeds the file bounds.");
    }
    const image = bytes.subarray(
      dataOffset + value.position,
      dataOffset + value.position + value.length,
    );
    if (imageType === "image/png") {
      const size = sniffImageSize(image);
      if (
        !size ||
        image[0] !== 0x89 ||
        size.width !== expectedSize ||
        size.height !== expectedSize
      )
        throw new Error(
          "ENV PNG face dimensions do not match their mip level.",
        );
    } else {
      const size = webpSize(image);
      if (!size || size.width !== expectedSize || size.height !== expectedSize)
        throw new Error(
          "ENV WebP face dimensions do not match their mip level.",
        );
    }
    ranges.push([value.position, value.position + value.length]);
  };
  info.specular.mipmaps.forEach((value, index) =>
    face(value, width / 2 ** Math.floor(index / 6)),
  );
  if (info.irradiance !== undefined && info.irradiance !== null) {
    const irradiance = info.irradiance;
    if (
      !record(irradiance) ||
      !["x", "y", "z", "xx", "yy", "zz", "xy", "yz", "zx"].every((key) =>
        triple(irradiance[key]),
      )
    )
      throw new Error(
        "ENV irradiance coefficients must be finite three-component vectors.",
      );
    const diffuse = irradiance.irradianceTexture;
    if (diffuse !== undefined) {
      if (
        !record(diffuse) ||
        !cubeSize(diffuse.size) ||
        diffuse.size < 2 ||
        !Array.isArray(diffuse.faces) ||
        diffuse.faces.length !== 6 ||
        (diffuse.dominantDirection !== undefined &&
          !triple(diffuse.dominantDirection))
      )
        throw new Error(
          "ENV irradiance texture requires six valid cube faces of at least 2×2.",
        );
      diffuse.faces.forEach((value) => face(value, diffuse.size as number));
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (
    ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])
  )
    throw new Error("ENV face data ranges must not overlap.");
  return {
    dimension: "cube",
    container: "env",
    encoding: "rgbd",
    width,
    height: width,
    mipLevels,
    prefiltered: true,
    hasIrradiance: info.irradiance !== undefined && info.irradiance !== null,
  };
}

function readDds(bytes: Uint8Array): EnvironmentTextureInfo {
  if (bytes.length < 128)
    throw new Error("DDS requires a complete 128-byte header.");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const get = (offset: number) => header.getUint32(offset, true);
  if (get(4) !== 124 || get(76) !== 32)
    throw new Error("DDS header sizes are invalid.");
  const width = get(16);
  const height = get(12);
  const mipLevels = get(28);
  if (
    !cubeSize(width) ||
    height !== width ||
    (get(112) & 0xfe00) !== 0xfe00 ||
    (get(112) & 0x200000) !== 0 ||
    get(24) > 1
  )
    throw new Error(
      "Environment DDS requires a square power-of-two cube with all six faces.",
    );
  if (!(get(8) & 0x20000) || mipLevels !== 1 + Math.log2(width))
    throw new Error(
      "Prefiltered DDS requires a complete mip chain through 1×1.",
    );
  let code = get(84);
  let dataOffset = 128;
  if (code === 0x30315844) {
    if (bytes.length < 148) throw new Error("DDS DX10 header is truncated.");
    if (get(132) !== 3 || !(get(136) & 4) || get(140) !== 1)
      throw new Error(
        "Environment DDS supports one 2D cube, without arrays or volumes.",
      );
    code = get(128) === 10 ? 113 : get(128) === 2 ? 116 : 0;
    dataOffset = 148;
  }
  if (
    !(get(80) & 4) ||
    (get(80) & (0x40 | 0x20000)) !== 0 ||
    (code !== 113 && code !== 116)
  )
    throw new Error(
      "Environment DDS supports linear RGBA16F/RGBA32F only. Import a prefiltered float DDS or RGBD ENV; RGB/DXT encodings are ambiguous.",
    );
  const pixelBytes = code === 113 ? 8 : 16;
  let dataBytes = 0;
  for (let level = 0; level < mipLevels; level++)
    dataBytes += (width / 2 ** level) ** 2 * pixelBytes * 6;
  if (!Number.isSafeInteger(dataBytes) || dataOffset + dataBytes > bytes.length)
    throw new Error("DDS face or mip data is truncated.");
  return {
    dimension: "cube",
    container: "dds",
    encoding: code === 113 ? "linearFloat16" : "linearFloat32",
    width,
    height,
    mipLevels,
    prefiltered: true,
    hasIrradiance: false,
  };
}

/** Validate only the supported import contract; no runtime filtering or pixel conversion. */
export function readEnvironmentTextureInfo(
  bytes: Uint8Array,
): EnvironmentTextureInfo {
  const container = environmentTextureContainer(bytes);
  if (container === "env") return readEnv(bytes);
  if (container === "dds") return readDds(bytes);
  throw new Error(
    "Choose a valid RGBD ENV or linear-float prefiltered DDS cube.",
  );
}
