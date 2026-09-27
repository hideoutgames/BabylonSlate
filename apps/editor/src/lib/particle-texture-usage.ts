import { textureNeedsParticleUsage, type ImageSize } from "@babylonslate/assets";
import {
  lowerMaterialDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";

/**
 * A particle Material samples a compressed Texture whose KTX2 is not whole 4x4
 * blocks, so WebGPU rejects it and the emitter draws nothing there. A warning:
 * nothing is skipped.
 */
export const PARTICLE_TEXTURE_USAGE_CODE = "particle.texture_block_align";

export const SET_PARTICLE_USAGE_LABEL = "Set Usage To Particle";

/** One Texture a Material binds, anchored to the Material graph node that names it. */
export interface MaterialTextureSample {
  textureGuid: string;
  nodeId?: string;
}

export interface ParticleTextureUsageWarning {
  code: typeof PARTICLE_TEXTURE_USAGE_CODE;
  severity: "warning";
  message: string;
  textureGuid: string;
  textureName: string;
  /** Texture Sample / Texture Parameter node, or the Function call holding it. */
  nodeId?: string;
  /** The encoded base size WebGPU rejects. */
  width: number;
  height: number;
}

interface TextureAssetLike {
  path: string;
  header: { type: string; name: string; payload?: Record<string, unknown> };
}

interface OpenDocumentLike {
  ref: { kind: string; path: string };
  content: unknown;
}

/**
 * Textures a particle-domain Material binds: only those reachable from its
 * output, including inside Material Functions (anchored to the call node).
 * When the Material does not lower, `whenInvalid: "nodes"` falls back to its
 * own texture nodes; otherwise it binds nothing. Other domains return none.
 */
export function particleMaterialTextureSamples(
  doc: MaterialDocument,
  functions: Record<string, MaterialFunctionDocument>,
  options: { whenInvalid?: "nodes" | "none" } = {},
): MaterialTextureSample[] {
  if (doc.domain !== "particle") return [];
  const lowered = lowerMaterialDocument(doc, { functions });
  if (!lowered.ok) {
    if (options.whenInvalid !== "nodes") return [];
    return doc.nodes.flatMap((node) => {
      const guid = node.properties.textureGuid;
      return typeof guid === "string" && guid !== ""
        ? [{ textureGuid: guid, nodeId: node.id }]
        : [];
    });
  }
  const operations = new Map(
    lowered.plan.operations.map((operation) => [operation.id, operation]),
  );
  return lowered.plan.textures.map((binding) => {
    const source = operations.get(binding.operationId)?.source;
    const nodeId = source ? (source.callPath[0] ?? source.nodeId) : undefined;
    return { textureGuid: binding.textureGuid, ...(nodeId ? { nodeId } : {}) };
  });
}

/**
 * One warning per sampled Texture that needs Particle Usage to load on
 * WebGPU, using the size its KTX2 encode has. An open Texture tab's Usage and
 * Downsample win over the saved header, so the warning clears on the edit.
 */
export function particleTextureUsageWarnings(
  samples: readonly MaterialTextureSample[],
  options: {
    textureByGuid: (guid: string) => TextureAssetLike | undefined;
    openDocuments: readonly OpenDocumentLike[];
    /** The registry's project max encode edge. */
    projectMax: number;
    /**
     * Decoded source size for a Texture whose header has none (extracted from
     * a Model); a Texture with neither size is not checked.
     */
    sourceSize?: (guid: string) => ImageSize | null | undefined;
  },
): ParticleTextureUsageWarning[] {
  const warnings: ParticleTextureUsageWarning[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (seen.has(sample.textureGuid)) continue;
    seen.add(sample.textureGuid);
    const asset = options.textureByGuid(sample.textureGuid);
    if (!asset || asset.header.type !== "Texture") continue;
    const open = options.openDocuments.find(
      (entry) => entry.ref.kind === "texture" && entry.ref.path === asset.path,
    );
    const payload =
      open?.content && typeof open.content === "object"
        ? (open.content as Record<string, unknown>)
        : (asset.header.payload ?? {});
    const size = textureNeedsParticleUsage(
      payload,
      options.projectMax,
      options.sourceSize?.(sample.textureGuid),
    );
    if (!size) continue;
    warnings.push({
      code: PARTICLE_TEXTURE_USAGE_CODE,
      severity: "warning",
      message: `Texture "${asset.header.name}" is ${size.width}×${size.height}; set its Usage to Particle so it loads on WebGPU.`,
      textureGuid: sample.textureGuid,
      textureName: asset.header.name,
      ...(sample.nodeId ? { nodeId: sample.nodeId } : {}),
      width: size.width,
      height: size.height,
    });
  }
  return warnings;
}
