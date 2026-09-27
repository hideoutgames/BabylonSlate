import {
  Constants,
  type InternalTexture,
  type RenderTargetWrapper,
} from "@babylonjs/core";
import type {
  ManagedRenderCategory,
  ManagedRenderResource,
} from "./managed-render-resources";

/** A declared physical texture allocation, before an Engine/FrameGraph creates it. */
export type RenderTargetStorage = {
  width: number;
  height: number;
  format: number;
  type?: number;
  layers?: number;
  depth?: number;
  cube?: boolean;
  /** Include allocated levels even when automatic mip generation is disabled. */
  mipLevels?: number | "full";
  samples?: number;
  /** Renderbuffers have no resolved texture or mip chain. */
  renderbuffer?: boolean;
};

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      "Invalid managed render-target storage dimensions or samples.",
    );
  return value;
}
function checked(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      "Managed render-target storage exceeds safe byte accounting.",
    );
  return value;
}

/** Representation bounds, not driver allocation measurements. RGB may expand
 * to RGBA; implementation-defined depth/stencil formats use padded bounds. */
function pixelBytes(
  format: number,
  type = Constants.TEXTURETYPE_UNSIGNED_BYTE,
): number {
  switch (format) {
    case Constants.TEXTUREFORMAT_DEPTH16:
      return 2;
    case Constants.TEXTUREFORMAT_DEPTH24:
    case Constants.TEXTUREFORMAT_DEPTH32_FLOAT:
      return 4;
    case Constants.TEXTUREFORMAT_DEPTH24_STENCIL8:
    case Constants.TEXTUREFORMAT_DEPTH24UNORM_STENCIL8:
    case Constants.TEXTUREFORMAT_DEPTH32FLOAT_STENCIL8:
      return 8;
    case Constants.TEXTUREFORMAT_STENCIL8:
      return 4;
  }
  const channels =
    format === Constants.TEXTUREFORMAT_R ||
    format === Constants.TEXTUREFORMAT_RED_INTEGER
      ? 1
      : format === Constants.TEXTUREFORMAT_RG ||
          format === Constants.TEXTUREFORMAT_RG_INTEGER
        ? 2
        : [
              Constants.TEXTUREFORMAT_RGB,
              Constants.TEXTUREFORMAT_RGB_INTEGER,
              Constants.TEXTUREFORMAT_RGBA,
              Constants.TEXTUREFORMAT_RGBA_INTEGER,
            ].includes(format)
          ? 4
          : 0;
  if (!channels) throw new Error("Unqualified managed render-target format.");
  switch (type) {
    case Constants.TEXTURETYPE_UNSIGNED_BYTE:
    case Constants.TEXTURETYPE_BYTE:
      return channels;
    case Constants.TEXTURETYPE_HALF_FLOAT:
    case Constants.TEXTURETYPE_SHORT:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT:
      return channels * 2;
    case Constants.TEXTURETYPE_FLOAT:
    case Constants.TEXTURETYPE_INT:
    case Constants.TEXTURETYPE_UNSIGNED_INTEGER:
      return channels * 4;
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_4_4_4_4:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_5_5_5_1:
    case Constants.TEXTURETYPE_UNSIGNED_SHORT_5_6_5:
      return 4; // May be expanded by WebGPU.
    case Constants.TEXTURETYPE_UNSIGNED_INT_2_10_10_10_REV:
    case Constants.TEXTURETYPE_UNSIGNED_INT_10F_11F_11F_REV:
    case Constants.TEXTURETYPE_UNSIGNED_INT_5_9_9_9_REV:
      return 4;
    default:
      throw new Error("Unqualified managed render-target component type.");
  }
}

/** Reserve before construction. Includes full lazy MSAA capacity plus its
 * resolved texture; depth and array/cube storage remain charged between draws. */
export function renderTargetAllocationBytes(
  layout: RenderTargetStorage,
): number {
  let width = positive(layout.width);
  let height = positive(layout.height);
  let depth = positive(layout.depth ?? 1);
  const layers = positive(layout.layers ?? 1) * (layout.cube ? 6 : 1);
  const samples = positive(layout.samples ?? 1);
  if (
    layout.depth !== undefined &&
    (layout.layers !== undefined || layout.cube)
  )
    throw new Error("A render-target volume cannot also be an array or cube.");
  const full = 1 + Math.floor(Math.log2(Math.max(width, height, depth)));
  const levels =
    layout.mipLevels === "full" ? full : positive(layout.mipLevels ?? 1);
  if (
    levels > full ||
    (layout.renderbuffer && (levels !== 1 || layers !== 1 || depth !== 1))
  )
    throw new Error(
      "Invalid managed render-target mip or renderbuffer layout.",
    );
  const pixelSize = pixelBytes(layout.format, layout.type);
  const base = checked(width * height * depth * layers * pixelSize);
  if (layout.renderbuffer) return checked(base * samples);
  let bytes = base;
  for (let level = 1; level < levels; level++) {
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    depth = Math.max(1, Math.floor(depth / 2));
    bytes += width * height * depth * layers * pixelSize;
  }
  if (samples > 1) bytes += base * samples;
  return checked(bytes);
}

function textureStorage(
  texture: InternalTexture,
  samples: number,
  allocatedMipLevels?: number | "full",
): RenderTargetStorage {
  if (!texture.isReady || !texture._hardwareTexture)
    throw new Error("Managed render target has no ready texture allocation.");
  const mipLevels = texture.generateMipMaps ? "full" : allocatedMipLevels;
  // Native WebGPU exposes actual allocation mip counts, including createMipMaps
  // with generation disabled. WebGL callers must preserve that creation option.
  const resource = texture._hardwareTexture.underlyingResource as {
    mipLevelCount?: number;
  } | null;
  const observedLevels = resource?.mipLevelCount;
  const levels =
    mipLevels === "full"
      ? "full"
      : Math.max(mipLevels ?? 1, observedLevels ?? 1);
  return {
    width: texture.width,
    height: texture.height,
    format: texture.format,
    type: texture.type,
    layers: texture.is2DArray ? texture.depth : undefined,
    depth: texture.is3D ? texture.depth : undefined,
    cube: texture.isCube,
    samples,
    mipLevels: levels,
  };
}

/** Reconcile a graph-owned InternalTexture before lazy wrappers exist. Explicit
 * samples describe multisample storage owned alongside this texture; a WebGL
 * wrapper's separate depth renderbuffer is accounted by the wrapper collector. */
export function managedRenderTextureResource(
  texture: InternalTexture,
  category: ManagedRenderCategory,
  options: { samples?: number; allocatedMipLevels?: number | "full" } = {},
): ManagedRenderResource {
  const samples = options.samples ?? Math.max(1, texture.samples);
  return {
    handle: texture,
    category,
    bytes: renderTargetAllocationBytes(
      textureStorage(texture, samples, options.allocatedMipLevels),
    ),
  };
}

/** Actual wrapper metadata reconciles the declared reservation. Returned texture
 * identities are shared across graph imports; commit deduplicates aliases.
 * Pass allocatedMipLevels when WebGL createMipMaps is true but generateMipMaps
 * is false. This helper never allocates or queries/binds a GPU resource. */
export function managedRenderTargetResources(
  target: RenderTargetWrapper,
  options: {
    colorCategory: ManagedRenderCategory;
    allocatedMipLevels?: number | "full";
  },
): ManagedRenderResource[] {
  const result: ManagedRenderResource[] = [];
  const depth = target.depthStencilTexture;
  const textures = target.textures ?? (target.texture ? [target.texture] : []);
  for (const texture of textures) {
    if (!texture || texture === depth) continue;
    const samples = Math.max(
      positive(target.samples),
      positive(texture.samples),
    );
    const layout = textureStorage(texture, samples, options.allocatedMipLevels);
    // Pinned WebGL hardware can own multiple per-face/layer MSAA buffers. More
    // buffers than the reserved image planes require a new qualified recipe.
    const hardware = texture._hardwareTexture as {
      _MSAARenderBuffers?: unknown[];
    };
    const planes = (layout.layers ?? layout.depth ?? 1) * (layout.cube ? 6 : 1);
    if ((hardware._MSAARenderBuffers?.length ?? 0) > planes)
      throw new Error("Unqualified additional managed MSAA attachments.");
    result.push(
      managedRenderTextureResource(texture, options.colorCategory, {
        samples,
        allocatedMipLevels: options.allocatedMipLevels,
      }),
    );
  }
  if (depth) {
    const samples = depth.getEngine().isWebGPU
      ? Math.max(positive(target.samples), positive(depth.samples))
      : 1;
    result.push(managedRenderTextureResource(depth, "depth", { samples }));
  }
  // Pinned WebGL 9.20: depth renderbuffers belong to the wrapper, separately
  // from its sampleable texture. Preserve their own identity when wrappers share
  // an attachment. WebGPU stores depth as an InternalTexture above.
  const glTarget = target as RenderTargetWrapper & {
    _depthStencilBuffer?: object | null;
  };
  if (glTarget._depthStencilBuffer) {
    result.push({
      handle: glTarget._depthStencilBuffer,
      bytes: renderTargetAllocationBytes({
        width: target.width,
        height: target.height,
        samples: positive(target.samples),
        format:
          depth?.format ??
          (target._generateStencilBuffer
            ? Constants.TEXTUREFORMAT_DEPTH24_STENCIL8
            : Constants.TEXTUREFORMAT_DEPTH24),
        renderbuffer: true,
      }),
      category: "depth",
    });
  }
  if (!result.length)
    throw new Error("Managed render target has no accounted attachments.");
  return result;
}
