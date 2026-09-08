import {
  Color4,
  InputBlock,
  RawTexture,
  Texture,
  type NodeMaterial,
} from "@babylonjs/core";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import type { MaterialBuildPlan } from "@babylonslate/shader-graph";
import type { BlockRealization } from "./material-block-registry";
import { isDisposedGpuTexture } from "./gpu-resource-live";

/** Reject invalid writes before replacing a component's replayable value. */
export function validMaterialParameterValue(
  parameter: MaterialParameterValue,
  resolveTexture?: (guid: string) => Texture | null,
): boolean {
  switch (parameter.kind) {
    case "float":
      return Number.isFinite(parameter.value);
    case "color":
      return (
        parameter.value.length === 4 && parameter.value.every(Number.isFinite)
      );
    case "texture": {
      if (!parameter.textureAssetGuid) return true;
      const texture = resolveTexture?.(parameter.textureAssetGuid);
      return (
        !!texture && !isDisposedGpuTexture(texture) && !texture.loadingError
      );
    }
  }
}

/** Bind authored parameter names to uniforms and to every sample of a Texture Parameter. */
export function createMaterialParameterBindings(
  plan: MaterialBuildPlan,
  realized: ReadonlyMap<string, BlockRealization>,
  material: NodeMaterial,
  resolveTexture?: (guid: string) => Texture | null,
) {
  const parameters = new Map(
    plan.operations
      .filter(
        (operation) =>
          operation.nodeType.startsWith("param.") &&
          operation.source.callPath.length === 0,
      )
      .map((operation) => [
        String(operation.properties.name ?? "").trim(),
        operation,
      ]),
  );
  const textureObservers = new Map<string, () => void>();
  let emptyTexture: RawTexture | null = null;
  let disposed = false;

  const whiteTexture = (): RawTexture => {
    emptyTexture ??= RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      material.getScene(),
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    return emptyTexture;
  };

  const dirty = (textures = false): void => {
    if (disposed) return;
    const scene = material.getScene();
    const blocked = scene.blockMaterialDirtyMechanism;
    scene.blockMaterialDirtyMechanism = false;
    try {
      material.markDirty(textures);
      // Frozen Play materials must upload changed uniforms on the next bind.
      scene.resetCachedMaterial();
    } finally {
      scene.blockMaterialDirtyMechanism = blocked;
    }
  };

  return {
    setParameter(name: string, parameter: MaterialParameterValue): boolean {
      if (disposed) return false;
      const operation = parameters.get(name);
      if (
        !operation ||
        operation.nodeType !== `param.${parameter.kind}` ||
        !validMaterialParameterValue(parameter, resolveTexture)
      )
        return false;
      if (parameter.kind === "texture") {
        const texture = parameter.textureAssetGuid
          ? (resolveTexture?.(parameter.textureAssetGuid) ?? null)
          : whiteTexture();
        const samples = plan.operations.filter((sample) => {
          const operand = sample.inputs.texture;
          return (
            operand?.kind === "operation" &&
            operand.operationId === operation.id
          );
        });
        let changed = false;
        for (const sample of samples) {
          const block = realized.get(sample.id)?.blocks[0] as
            { texture?: Texture | null } | undefined;
          if (!block || block.texture === texture) continue;
          block.texture = texture;
          changed = true;
        }
        if (!changed) return true;
        textureObservers.get(name)?.();
        textureObservers.delete(name);
        if (texture && texture !== emptyTexture && !texture.isReady()) {
          const observer = texture.onLoadObservable.addOnce(() => dirty(true));
          textureObservers.set(name, () =>
            texture.onLoadObservable.remove(observer),
          );
        }
        dirty(true);
        return true;
      }
      const block = realized.get(operation.id)?.blocks[0];
      if (!(block instanceof InputBlock)) return false;
      if (parameter.kind === "float") {
        block.value = parameter.value;
      } else {
        const [r, g, b, a] = parameter.value;
        block.value = new Color4(r, g, b, a);
      }
      dirty();
      return true;
    },
    dispose(): void {
      disposed = true;
      for (const remove of textureObservers.values()) remove();
      textureObservers.clear();
      if (emptyTexture) {
        for (const realization of realized.values()) {
          for (const block of realization.blocks) {
            const textured = block as { texture?: Texture | null };
            if (textured.texture === emptyTexture) textured.texture = null;
          }
        }
        emptyTexture.dispose();
        emptyTexture = null;
      }
    },
  };
}
